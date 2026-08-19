# LLD: Enforce a Terminal Hard Stop for Continuation Prompts

## Status

- **Status:** Implemented; pending review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-20
- **Related task or issue:** Prevent Cline from reaching `quote>`, `dquote>`, `heredoc>`, bare `>`, or Python continuation prompts during continuous development.

## Problem and observed evidence

The terminal reliability guidance already discourages `cat` redirection, heredocs, Python stdin,
and nested shell commands. It is not forceful enough: a long inline command can still be sent to a
shell, become syntactically incomplete, and leave the terminal waiting for more input. The latest
incident reached a `quote>` continuation prompt while creating a remote PR command, interrupting
continuous development.

Once a shell parser is waiting at `quote>` or `heredoc>`, a repository file cannot rescue that
already-submitted command. Prevention must therefore happen before the command is sent, with a
repository-visible hard-stop policy and a bounded execution wrapper for commands that are allowed
to run.

## Goals

1. Make unsafe shell/Python input forms absolute prohibitions for agent-authored work.
2. Require inspectable script files for all non-trivial multiline or quoted logic.
3. Provide a local runner that refuses unsafe command shapes, never gives children terminal stdin,
   bounds execution time/output, and terminates timed-out process groups.
4. Make recovery from a continuation prompt interrupt-first and state-verification-first.
5. Harden the canonical global skills without creating duplicate skill names.

## Non-goals

- Do not attempt to intercept a malformed command after an external shell has already entered `quote>`.
- Do not modify application runtime behavior or database schema.
- Do not automatically guess a closing quote or heredoc delimiter.
- Do not read, print, stage, or persist credentials or environment files.
- Do not make the safe runner a general sandbox; it is a command-shape and lifecycle guard.

## Requirements and acceptance criteria

- Root `AGENTS.md` contains an explicit MUST NOT list for `cat >`/`cat >>`, all heredoc forms, shell
  `-c`/`-i`, Python `-`/`-c`/REPL use, `eval`, nested shells, and long inline command chains.
- Non-trivial authored logic must be created with the patch/editor operation as a script file,
  inspected, then executed through `scripts/safe-run.mjs` as a separate command.
- `scripts/safe-run.mjs` uses `shell: false`, ignores child stdin, requires a finite timeout, caps
  output, and terminates the process group on timeout or output overflow.
- The runner rejects unsafe command arguments and unsafe Bash/sh/zsh/Python script content before
  spawning the child.
- Global `terminal-reliability`, `scripted-edit-reliability`, and `lld-driven-development` skills
  contain the same absolute hard-stop policy and recovery sequence.
- Repository terminal and workflow documents cross-reference the safe runner and use MUST/MUST NOT
  language rather than suggestions.
- Regression tests cover command rejection, script-content rejection, successful direct execution,
  stdin isolation, timeout termination, and capped output.
- All authored files pass `git diff --check`, tests, typecheck, and build.

## Existing architecture and affected boundaries

- Global skills: `~/.agents/skills/{terminal-reliability,scripted-edit-reliability,lld-driven-development}/SKILL.md`.
- Repository agent contract: `AGENTS.md` and `workflows/default/WORKFLOW.md`.
- Repository operations: `scripts/safe-run.mjs`, `scripts/install-terminal-hardening.mjs`, and
  `scripts/verify-hard-stop.mjs`.
- Regression tests: `tests/safe-run.test.ts`.
- Local operational guidance: `docs/terminal-reliability.md`.

## Proposed design

### Hard-stop policy

The policy is intentionally stronger than “prefer”:

```text
agent-authored command
  -> safe direct command with ignored stdin
  OR inspected script file through safe-run
  -> otherwise refuse to send it
```

Prohibited command shapes include `<<`, `cat >`, `cat >>`, shell `-c`/`-i`, Python `-`/`-c`,
interactive REPLs, `eval`, nested shell invocations, unclosed quotes/backslashes/command
substitutions, and long mutation chains. A complete heredoc is not an exception for agent-authored
work in this repository; use the patch/editor operation instead.

### Safe runner

`node scripts/safe-run.mjs --timeout-ms 120000 -- <direct command> [args...]`:

1. Parses a required finite timeout and optional output cap.
2. Rejects forbidden command forms before spawn.
3. Inspects direct `.sh`, `.bash`, `.zsh`, and `.py` scripts for forbidden shell-fed input.
4. Spawns with `shell: false` and `stdio: ["ignore", "pipe", "pipe"]`.
5. Captures at most the configured output cap.
6. Terminates the detached process group on timeout or output overflow.
7. Returns the child exit code or a non-zero guard code with a concise reason.

Node scripts are allowed as inspectable script files because the runner itself is Node-based; they
must still use bounded child processes and must not read secrets. The runner is a guard, not a
replacement for the hard-stop instruction.

### Global skill installer

`scripts/install-terminal-hardening.mjs` performs exact marker-based, idempotent appends to the
three canonical global skill files. It fails if a target is missing, never prints file contents or
secrets, and can be rerun safely. It is executed directly through the safe runner and each global
file is read back independently afterward.

## Data and state transitions

```text
prepare command -> classify shape
  -> direct safe command -> safe-run -> bounded execution -> verify
  -> multiline/quoted logic -> patch-created script -> inspect -> safe-run -> verify -> cleanup
  -> unsafe shape -> refuse before shell spawn
```

```text
continuation prompt -> Ctrl-C/cancel -> classify unknown -> inspect target/process/git state
                    -> recover from last verified checkpoint -> verify before cleanup/retry
```

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| A malformed command is submitted outside the runner | Root/global MUST NOT policy prevents submission; recovery never feeds guessed delimiters. |
| A valid tool needs stdin | The safe runner is for agent-authored development commands; use an explicit reviewed exception outside it. |
| Child spawns descendants | Detached process group is terminated on timeout/overflow and cleanup is verified. |
| Output cap hides useful diagnostics | Preserve a bounded prefix and state that output was truncated. |
| Global skill install partially writes | Exact marker checks, atomic temp-file rename, and readback each target independently. |
| Runner rejects a legitimate command | Use a patch-created script file and direct interpreter path; record a narrowly scoped follow-up if needed. |

Rollback reverts the repository docs/scripts/tests and removes only the marker sections added to the
three global skills. No runtime/data rollback is needed.

## Validation plan

1. Test safe-runner rejection and success paths.
2. Run the installer through the safe runner and independently read back all global skill files.
3. Run `git diff --check`, `npm test`, `npm run typecheck`, and `npm run build` as separate bounded commands.
4. Verify no temporary script or unintended process remains.
5. Update this LLD with exact results and the PR identifier.

## Decision log

- 2026-08-20: Guidance-only rules were insufficient because the agent still submitted a long inline command that reached `quote>`.
- 2026-08-20: A complete heredoc is no longer an agent-authored exception; patch-created script files are mandatory for multiline logic.
- 2026-08-20: A local runner uses `shell: false`, ignored stdin, finite timeout, output cap, and process-group cleanup.

## Open questions and assumptions

- Assumption: agents working in this repository read root `AGENTS.md` before terminal operations.
- Assumption: Node.js 22 is available, as required by the repository.
- Open question: other repositories need to install or vendor the safe runner if they want the same execution boundary.

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 15 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed. Next reported the existing
  non-fatal Turbopack NFT tracing warning through `next.config.mjs` and `src/lib/server/db.ts`.
- `npm run safe:run -- --timeout-ms 120000 -- node scripts/install-terminal-hardening.mjs` —
  second run reported all three global markers as already present; installer is idempotent.
- Global readback — verified `ABSOLUTE TERMINAL HARD STOP` in all three canonical global skill files.
- The runner tests verified pre-spawn rejection, unsafe script rejection, ignored stdin, timeout
  process-group termination, and output capping.
- `npm run safe:run -- --timeout-ms 120000 -- node scripts/verify-hard-stop.mjs` — passed; all
  global markers and repository hard-stop files were verified without printing their contents.
- PR #12 — verified open at
  `https://github.com/maxlee98/project-agent-control-plane/pull/12`, targeting the stacked base
  branch `fix/github-task-status-reconciliation`; no merge was performed.

## Completion checklist

- [x] Design reviewed
- [x] Hard-stop runner and tests implemented
- [x] Global skills hardened
- [x] Repository workflow guidance hardened
- [x] Tests, typecheck, build, and diff checks passed
- [x] Global skill readback verified
- [x] Dedicated branch pushed and PR opened
- [x] Human merge approval remains pending