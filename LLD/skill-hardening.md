# LLD: Harden LLD and Terminal Reliability Skills

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-19
- **Related task or issue:** Improve the existing global `lld-driven-development` and `terminal-reliability` skills so continuous agent development is not interrupted by skipped design work or stuck shell/Python input.

## Problem

The repository already relies on two global skills:

- `~/.agents/skills/lld-driven-development/SKILL.md` defines the durable LLD workflow.
- `~/.agents/skills/terminal-reliability/SKILL.md` defines bounded terminal execution and recovery.

The terminal skill does not explicitly address the shell states that commonly stop continuous agent work: `quote>`, `dquote>`, `heredoc>`, and Python continuation prompts. In particular, commands built with `cat > file`, interactive heredocs, or an accidental unclosed quote can wait for stdin indefinitely. The LLD skill also needs a more explicit phase-gate and self-review contract so design, implementation, validation, and handoff remain recoverable across context changes.

## Goals

1. Preserve and strengthen the existing LLD-first development workflow.
2. Make design, implementation, validation, and handoff checkpoints explicit.
3. Prevent agent terminal commands from entering unbounded shell or Python input modes.
4. Provide a safe recovery procedure when a command is already stuck.
5. Keep repository-local terminal guidance aligned with the global skill.

## Non-goals

- Do not create duplicate skill names when the requested skills already exist.
- Do not change application runtime code, database schema, or agent orchestration behavior.
- Do not remove support for legitimate non-interactive heredocs when a complete, quoted delimiter is required.
- Do not print, copy, or persist credentials, environment files, or sensitive terminal output.
- Do not modify unrelated global skills.

## Requirements and acceptance criteria

- The LLD skill requires an LLD before implementation and rereading/updating it at major phase boundaries.
- The LLD skill requires implementation self-review and records actual validation and handoff results before completion.
- The terminal skill recommends patch/editor operations instead of `cat > file` for agent-authored file changes.
- The terminal skill forbids interactive Python REPL use, unsafe/unclosed shell input patterns, and
  shell-fed Python heredocs such as `python3 - <<'PY'` when the patch/editor operation is available.
- The terminal skill documents bounded multiline-input rules and recovery for `quote>`, `dquote>`, `heredoc>`, and Python continuation prompts.
- The repository-local terminal document references the new safeguards.
- The changed Markdown files pass `git diff --check`; global skill content is independently read back after editing.

## Existing architecture

Skills are global agent instructions under `~/.agents/skills/`. The repository adds local workflow context through `workflows/default/WORKFLOW.md` and local operational guidance through `docs/terminal-reliability.md`. The repository’s existing LLD documents under `LLD/` are the durable design artifacts for implementation work.

## Proposed design

### LLD-driven development

Add an explicit phase-gate section:

1. Intake and scope: identify the repository, requirements, constraints, and success criteria.
2. Design: create or update the LLD before code changes.
3. Implementation: reread the LLD, make focused changes, and update decisions when scope changes.
4. Verification: run narrow checks followed by project checks and record exact outcomes.
5. Handoff: summarize changed boundaries, remaining uncertainty, and verified identifiers.

Add a self-review checklist covering readability, modularity, testability, domain alignment, and framework/language best practices.

### Terminal reliability

Add shell-input safety rules that distinguish safe non-interactive commands from commands that can consume stdin. Prefer the patch/editor tool for file writes. Require complete quoted heredoc delimiters when multiline shell input is unavoidable. Ban agent-started interactive Python REPLs and avoid shell-fed Python heredocs such as `python3 - <<'PY'` when the patch/editor operation is available. Use bounded `python3 -c` only for short, fully quoted operations. Add a recovery playbook that cancels the stuck input first, inspects process and file state separately, and only then resumes from the last verified checkpoint.

## Data and state transitions

This is a documentation-only change. No application data or runtime state transitions are introduced. The operational state model is:

```text
command prepared -> command executed -> exit/result observed
                                  \-> interrupted/unknown -> inspect -> recover -> verify
```

For LLD work:

```text
task intake -> LLD proposed -> implementation in progress -> checks recorded -> handoff verified
```

## Affected files and boundaries

- `LLD/skill-hardening.md`: this task’s durable design and completion record.
- `docs/terminal-reliability.md`: repository-specific terminal rules.
- `~/.agents/skills/lld-driven-development/SKILL.md`: global LLD workflow.
- `~/.agents/skills/terminal-reliability/SKILL.md`: global terminal workflow and stuck-input recovery.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Global skill edits affect unrelated repositories | Keep changes additive, narrowly scoped, and limited to the two selected skill files. |
| A valid multiline command is incorrectly avoided | Permit only complete, quoted, non-interactive heredocs when patch/editor tools are unsuitable. |
| The agent is already at a continuation prompt | Send `Ctrl-C`/EOF as appropriate, then inspect state; never assume the prior mutation completed. |
| A command timed out after a side effect | Classify it as unknown and query the expected file/process/remote state before retrying. |
| Documentation drifts from the global skill | Update the repository-local document in the same task and verify both files. |

Rollback is deleting or reverting only the added LLD and the targeted documentation sections. No runtime rollback or data migration is needed.

## Validation plan

1. Read back both global `SKILL.md` files and confirm the new sections are present.
2. Run `git diff --check` for repository changes.
3. Run `npm test`, `npm run typecheck`, and `npm run build` as separate bounded checks; record results here.
4. Verify no unintended process was started and no sensitive file was read or printed.

### Validation results

- Global skill readback: verified the new phase-gate/self-review content in
  `~/.agents/skills/lld-driven-development/SKILL.md` and the shell-input/recovery content in
  `~/.agents/skills/terminal-reliability/SKILL.md`.
- `git diff --check`: verified success with exit status 0.
- `npm test`: verified success; 3 tests passed, 0 failed.
- `npm run typecheck`: verified success; `tsc --noEmit` completed without diagnostics.
- `npm run build`: verified success; Next.js compiled, typechecked, generated 5 static pages, and
  finalized route optimization. The existing Turbopack NFT tracing warning points through
  `next.config.mjs` and `src/lib/server/db.ts`; it does not fail the build and is unrelated to
  these documentation changes.
- Process cleanup: no project test, TypeScript, or Next build process remained in the follow-up
  inspections. No server was started by this task.
- Working-tree boundary: `git status --short` showed pre-existing changes in
  `src/lib/domain.ts`, `src/lib/server/cline.ts`, `src/lib/server/db.ts`,
  `src/lib/server/repository.ts`, and `src/lib/server/paths.ts`; these were not modified by this
  task and must remain with their existing owner/workflow.

## Decision log

- 2026-08-19: The requested skills were found to already exist globally, so this task improves those canonical files instead of creating duplicates.
- 2026-08-19: Patch/editor operations are the preferred file-writing mechanism because shell-fed `cat` and incomplete heredocs can leave the agent waiting for stdin.
- 2026-08-19: Interactive Python REPL use is disallowed for agent terminal operations; short non-interactive commands are safer and easier to verify.
- 2026-08-19: Python heredoc input is explicitly covered because an incomplete `python3 - <<'PY'`
  command can produce the same stuck shell continuation prompts as a `cat` heredoc.
- 2026-08-19: Validation completed successfully. The build warning is recorded rather than fixed
  because application runtime changes are outside this task's scope.

## Open questions and assumptions

- Assumption: the global skill directory is writable by the operator and is the intended installation location.
- Assumption: project checks are appropriate even though the application code is unchanged, because they provide a regression signal for repository health.
- Open question: none blocking implementation; future skill distribution may need a versioned installation mechanism.

## Completion checklist

- [x] Design reviewed
- [x] Global LLD skill hardened
- [x] Global terminal skill hardened
- [x] Repository terminal guidance updated
- [x] Tests, typecheck, and build passed or their verified outcomes recorded
- [x] Documentation updated
- [x] Handoff verified