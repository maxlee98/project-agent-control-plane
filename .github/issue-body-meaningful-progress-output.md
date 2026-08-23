## Summary

Make agent progress communication useful to humans by publishing meaningful lifecycle, intent, workspace,
branch, validation, and next-action information to GitHub Issues and the local Run console.

Related to parent Issue #70: https://github.com/maxlee98/project-agent-control-plane/issues/70

## Priority

Priority: P2

## Context and evidence

The existing run history included low-value Cline SDK activity such as tool calls, session-start events,
and generic output chatter. Humans need to know whether the run started, where it is working, what task or
LLD objective it is pursuing, what happened, and what should happen next. A bounded completed agent output
summary is useful and should remain available as part of that progress record.

## Problem

GitHub Issue comments and the Run console do not consistently present a concise operational narrative. They
either omit useful workspace/branch context or expose implementation-level events that are not useful for
human review.

## Goals and non-goals

### Goals

- Publish start, workspace, branch, current intent, next action, validation, failure, stop, and handoff information.
- Retain useful bounded completed agent output summaries as human-facing progress.
- Remove tool-call, session-start, generic notice, and raw output-start noise from visible run history.
- Keep direct Issue, comment, pull-request, local activity, and event output redacted and bounded.
- Preserve existing Demo/live parity, checkpoint throttling, deduplication, and result-authoritative completion.

### Non-goals

- Do not publish raw Cline SDK payloads, prompts, reasoning, tool input/output, credentials, or full local paths.
- Do not change the database schema, worktree lifecycle, validation commands, or automatic merge behavior.

## Acceptance criteria

- [ ] Live Issue checkpoints show a safe workspace label, branch, `Now`, `Next`, and relevant validation/handoff data.
- [ ] A bounded completed agent output summary can appear in the Issue handoff/progress record and local history.
- [ ] Tool lifecycle, session-start, generic notice, and raw output-start events do not appear in the visible Run console.
- [ ] Existing persisted tool/session noise is hidden from Run console reads without a destructive migration.
- [ ] Direct Issue/comment/PR content and stored human context follow the existing redaction boundary.
- [ ] Focused tests, full tests, typecheck, production build, and whitespace checks pass.

## Affected areas

`src/lib/server/cline.ts`, `src/lib/server/orchestrator.ts`, `src/lib/server/issue-checkpoints.ts`,
`src/lib/server/github.ts`, `src/lib/server/repository.ts`, focused tests, `LLD/70-human-readable-progress-logging.md`,
and `workflows/default/WORKFLOW.md`.

## Validation

- Focused Cline, checkpoint, GitHub boundary, live-run, and legacy-event filtering tests.
- Full `npm test`, `npm run typecheck`, production `npm run build`, and `git diff --check`.

## Risks and rollback

The primary risk is suppressing a useful progress signal. Forced host-owned lifecycle and validation
milestones remain, and completed agent summaries are retained in bounded form. The change can be rolled
back as a code-only revert; no destructive data migration is required.

## Follow-up questions

None.