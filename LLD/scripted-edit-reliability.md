# LLD: Scripted Edit Reliability

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-19
- **Related task or issue:** Prevent Cline from getting stuck or corrupting files when using long Python, Bash, sh, or zsh command strings for multi-line replacements.

## Problem

Inline multi-line commands are fragile in agent terminals. Python `-c` commands can fail because
of shell quote escaping or command-length limits. Bash/sh/zsh commands can enter `quote>`,
`dquote>`, `heredoc>`, or bare `>` continuation prompts when input is incomplete. Shell-fed script
authoring also makes it difficult to distinguish an interrupted command from a completed mutation.

## Goals

1. Provide one language-agnostic global skill for safe scripted edits.
2. Require temporary Python or shell script files for non-trivial multi-line logic.
3. Prevent unbounded stdin, nested quoting, and shell continuation prompts.
4. Require assertions before writes, independent verification after writes, and cleanup only after success.
5. Preserve recoverability when a script or terminal command is interrupted.

## Non-goals

- Do not replace the existing LLD-first or terminal-reliability skills.
- Do not prohibit short, direct commands that have no quoting or stdin risk.
- Do not permit scripts to read credentials, environment files, or process environments.
- Do not automatically delete an interrupted temporary script before its state is understood.

## Requirements and acceptance criteria

- The new global skill exists at `~/.agents/skills/scripted-edit-reliability/SKILL.md`.
- Python multi-line transformations use a temporary `.py` file rather than inline `python3 -c` or a Python heredoc.
- Bash/sh/zsh multi-line logic uses a temporary `.sh` file rather than inline nested shell commands or heredocs.
- Temporary scripts use bounded, focused execution and safe shell settings where applicable.
- File replacements assert the expected match count and target state before writing.
- The skill covers quote, double-quote, heredoc, bare continuation, Python REPL, and interrupted-command recovery.
- The skill is cross-referenced from the existing global terminal skill and this repository’s terminal document.

## Existing architecture

Global agent skills live under `~/.agents/skills/`. This repository keeps local operational guidance
in `docs/terminal-reliability.md` and durable task context under `LLD/`.

## Proposed design

Create a language-agnostic `scripted-edit-reliability` skill with separate policies for:

- **Python:** patch/create a temporary script, assert exact input matches, execute with `python3`,
  verify, then remove only after success.
- **Shell:** patch/create a temporary `.sh` script, use `set -euo pipefail`, execute with the
  intended shell, verify each side effect, then remove only after success.

Both paths forbid inline large commands, nested shell quoting, `eval`, interactive input, and
shell-fed script authoring when an editor/patch operation is available.

## Affected files and boundaries

- `LLD/scripted-edit-reliability.md`: durable design and validation record.
- `docs/terminal-reliability.md`: repository-local cross-reference.
- `~/.agents/skills/scripted-edit-reliability/SKILL.md`: new global skill.
- `~/.agents/skills/terminal-reliability/SKILL.md`: discovery cross-reference.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Temporary script is deleted before an interrupted write is understood | Keep it until target state and process state are verified. |
| An expected replacement appears multiple times | Require exact match counts or fail before writing. |
| Shell script partially executes | Use `set -euo pipefail`, separate mutation and verification, and classify interruption as unknown. |
| A script accidentally reads secrets | Ban environment-file/process-environment reads and use redaction rules. |
| Temporary files enter Git | Keep them outside the repository or verify `git status` before cleanup/handoff. |

Rollback is limited to removing the new skill and its cross-references; no runtime data is changed.

## Validation plan

1. Read back the new global skill and both cross-references.
2. Confirm required Python and shell safeguards appear with focused searches.
3. Run `git diff --check`.
4. Verify no temporary script or unintended process remains.

### Validation results

- Read back `~/.agents/skills/scripted-edit-reliability/SKILL.md`: verified Python and shell
  temporary-script workflows, exact-match assertions, bounded execution, stuck-prompt recovery,
  secret handling, and delayed cleanup.
- Read back `~/.agents/skills/terminal-reliability/SKILL.md` and
  `docs/terminal-reliability.md`: verified the cross-reference and intact shell-input paragraph.
- Executed two temporary Python repair scripts as separate commands; both used exact-match
  assertions and exited successfully. Both were removed only after readback verification.
- `git diff --check`: verified success.
- Temporary-script cleanup: verified the repair scripts no longer exist under `/tmp`.
- No application server, remote write, or unrelated process was started by this skill task.

## Decision log

- 2026-08-19: The skill is language-agnostic because Bash/sh/zsh can become stuck for the same stdin and quoting reasons as Python.
- 2026-08-19: Temporary scripts are preferred over inline multi-line commands because they avoid shell escaping and command-length failures and can be independently inspected.
- 2026-08-19: The first cross-reference patch exposed the risk of fuzzy multi-line edits; the repair was completed with a temporary script, exact-match assertions, independent readback, and delayed cleanup.

## Completion checklist

- [x] Design reviewed
- [x] Global scripted-edit skill created
- [x] Existing terminal skill cross-referenced
- [x] Repository guidance updated
- [x] Validation completed
- [x] Handoff verified