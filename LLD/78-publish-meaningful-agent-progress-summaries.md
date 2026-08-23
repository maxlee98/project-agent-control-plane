# LLD: Publish Meaningful Agent Progress Summaries

## Status

- **Status:** Implemented; ready for review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-23
- **Related task or issue:** GitHub Issue #78 — [Publish meaningful agent progress summaries](https://github.com/maxlee98/project-agent-control-plane/issues/78)
- **Parent issue:** GitHub Issue #70 — [Refactor agent logs into human-readable progress updates](https://github.com/maxlee98/project-agent-control-plane/issues/70)

## Problem

The agent-facing Issue comments and local Run console mixed useful progress with implementation-level
Cline SDK events. Humans need a concise operational narrative: whether the run started, which safe
workspace and branch are active, what task or LLD objective is being pursued, what validation found, and
what should happen next. A bounded completed agent output summary is useful when it communicates intent or
the result of the task turn.

## Goals and non-goals

### Goals

- Publish start, workspace, branch, current intent, next action, validation, failure, stop, and handoff information.
- Retain bounded completed agent output summaries in local history and the GitHub Issue checkpoint narrative.
- Remove tool-call, session-start, generic notice, and raw output-start noise from visible run history.
- Redact and bound direct Issue, comment, pull-request, activity, and event output.
- Preserve Demo/live parity, checkpoint throttling, deduplication, and result-authoritative completion.

### Non-goals

- Do not publish raw SDK payloads, prompts, reasoning, tool input/output, credentials, or absolute local paths.
- Do not change the database schema, worktree lifecycle, validation commands, or automatic merge behavior.

## Design

The host orchestrator owns lifecycle facts and renders checkpoints with a stable projection containing:

```text
phase, status, safe workspace label, branch, progress, Now, Next,
validation, changed files, commit, pull request, and bounded blocker detail
```

GitHub receives the safe workspace label rather than an absolute filesystem path. The branch, current
intent, next action, validation result, and handoff metadata are included when available. Ordinary progress
is still throttled and duplicate rendered comments are suppressed.

The Cline integration retains only bounded completed text summaries and explicit waiting/error observations
as candidates. Tool lifecycle events, session-start events, generic notices, raw output starts, usage,
status, iteration, snapshots, chunks, and unknown hooks do not enter the human-facing event trace. The
repository read path also hides legacy tool/session rows without a destructive migration.

## Affected boundaries

- `src/lib/server/issue-checkpoints.ts`: safe projection fields and checkpoint rendering.
- `src/lib/server/orchestrator.ts`: host-owned lifecycle, intent, next-action, validation, and handoff data.
- `src/lib/server/cline.ts`: output-summary retention and tool/SDK noise filtering.
- `src/lib/server/repository.ts`: legacy visible-event filtering and redacted human context.
- `src/lib/server/github.ts`: redacted Issue, comment, and pull-request payload boundaries.
- Focused tests and workflow documentation: contract, security, and operator guidance.

## Data, compatibility, and security

No database migration is required. Existing rows remain stored, but the Run console read projection hides
legacy session/tool events. New and remotely published content is scalar, redacted, and length-bounded.
Absolute workspace paths remain local-only. Checkpoint failures are best-effort warnings and cannot change
the run’s authoritative completion state.

## Validation

- Focused Cline/checkpoint/GitHub/live-run/legacy-event tests — passed.
- Full `npm test` — 101 passed, 0 failed.
- `npm run typecheck` — passed.
- `NODE_ENV=production npm run build` — passed; existing non-fatal Turbopack NFT warning remains.
- `git diff --check` — passed.

## Risks and rollback

The main risk is suppressing a useful progress signal. Forced host-owned lifecycle, validation, blocker,
stop, and handoff milestones remain, and bounded completed summaries are retained. Rollback is a code-only
revert; no destructive data operation is required.

## Follow-ups

- Human review should confirm the balance between concise Issue comments and the expanded local Run history.
- Issue #70 remains the parent context; this Issue is the canonical task reference for the implementation PR.