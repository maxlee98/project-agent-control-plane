# LLD: Record Blocked-Run Reasons and Guide Unblock Continuations

## Status

- **Status:** Implementation complete; pending PR review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-23
- **Related task or issue:** GitHub Issue #63 — [Record blocked-run reasons and guide unblock continuations](https://github.com/maxlee98/project-agent-control-plane/issues/63)

## Problem

When a Live agent run fails before pull-request handoff, the control plane correctly preserves the
workspace and moves the task to `blocked`, but the linked GitHub Issue only receives a generic failed
checkpoint. The reason is visible in local run history, not in the Issue's durable collaboration trail.

When an operator starts a continuation or retry, `createRun()` also replaces the task summary with the
new run's preparation message before `buildPrompt()` runs. As a result, the new agent turn is not
explicitly given the previous run's failure reason or directed to diagnose and remove the blocker.

## Goals

1. Publish a concise, redacted explanation to the canonical Issue whenever a Live run transitions to
   the blocked/failed outcome.
2. Preserve the source run's failure context before a continuation/retry mutates the task summary.
3. Give continuation and retry turns explicit instructions to inspect the available state, avoid blindly
   repeating the failed approach, and find a safe unblock path or clearly identify required human input.
4. Keep failure comments best-effort and preserve existing local failure state if GitHub is unavailable.
5. Keep Demo mode local and avoid exposing secrets, raw provider payloads, or unbounded output.

## Non-goals

- Do not change the task status vocabulary or introduce a new database table.
- Do not infer that a blocked task is unblocked without a successful run and existing handoff checks.
- Do not post every agent event or raw Cline output to GitHub.
- Do not change successful PR handoff, human comments, operator stop, or ordinary checkpoint semantics.

## Existing architecture and affected boundaries

- `src/lib/server/orchestrator.ts` owns Live stage failures, prompt construction, task state changes, and
  Issue checkpoint publication.
- `src/lib/server/issue-checkpoints.ts` formats and serializes best-effort Issue comments.
- `src/lib/server/repository.ts` is the durable local source for task/run summaries and failure history.
- `src/lib/server/github.ts` provides the injected REST Issue comment boundary.
- `src/app/api/runs/[runId]/continue/route.ts` and `retry/route.ts` pass the source run ID into dispatch.
- `tests/live-run.test.ts` and `tests/issue-checkpoints.test.ts` cover the relevant integration seams.

## Proposed design

### Recovery prompt context

Capture the source run before `createRun()` updates the task. For `continue` and `retry`, append a fixed,
bounded recovery section to the prompt containing the source run ID, stage-aware failure message, and an
instruction to:

```text
Treat the previous run failure as a blocker to diagnose. Inspect the preserved workspace and repository
state, find a safe way to unblock the task, and do not blindly repeat the failed approach. If a human
decision, credential, or external change is required, explain exactly what is needed in the handoff.
```

Only redacted, bounded failure text enters the prompt. A fresh `start` run without a failed source run
does not receive recovery instructions; the normal blocked-task rerun path supplies its latest failed run
as the source even though its mode remains `start`.

### Blocked Issue comment

On the Live executor catch path, after local run/task failure state is persisted, force one `failed`
checkpoint with a bounded detail containing the stage and redacted reason. The formatter will label the
comment as a blocked-run explanation and include a next-step instruction to inspect the preserved
workspace or provide the missing human input. The existing serialized publisher handles ordering and
best-effort failure reporting.

### Safety and compatibility

Failure comments use existing `redactSecrets()` and length limits. Local run error, task summary, and
event/activity records retain their current redaction behavior. A comment failure emits the existing
checkpoint warning and cannot overwrite `blocked`/`failed` local state. Demo scheduling never creates a
publisher and never calls GitHub.

## Data and state transitions

```text
Live run failure
  -> persist run failed + task blocked + local diagnostics
  -> enqueue redacted Issue blocked-reason comment (best effort)

blocked task + continue/retry
  -> capture source run failure
  -> create new running run
  -> prompt includes blocker diagnosis/unblock instructions
```

## Acceptance criteria

- Every Live run that reaches the existing blocked failure path attempts one Issue comment containing the
  failed stage and a redacted reason.
- The failure comment is bounded, does not contain configured credentials, and explains how to proceed.
- A continuation and retry prompt contains the previous run's failure context and explicit unblock
  guidance even though the task summary is reset for the new run.
- Comment publication failure leaves the run `failed`, task `blocked`, and local diagnostics intact.
- Demo runs make no GitHub requests.
- Existing successful handoff, optional handoff-comment warning, stop, and checkpoint tests remain valid.

## Validation plan

1. Add unit coverage for blocked-comment formatting, bounded/redacted detail, and recovery prompt text.
2. Add mocked Live executor coverage for successful publication and publication failure.
3. Run focused tests, the complete test suite, typecheck, production build, and `git diff --check` through
   `npm run safe:run`.
4. Verify the feature branch is fresh with the current `main` before PR creation.

## Decision log

- 2026-08-23: Confirmed Issue #63 as the canonical task identity.
- 2026-08-23: Reuse the existing serialized Issue checkpoint publisher rather than adding a separate
  comment transport or schema migration.
- 2026-08-23: Capture source-run context at dispatch because task-summary mutation currently occurs in
  `createRun()` before prompt construction; a blocked-task `start` also resolves its latest failed run so
  the dashboard rerun path receives the same recovery context as explicit retry/continue.

## Completion checklist

- [x] Recovery prompt context implemented
- [x] Blocked-run Issue comment implemented
- [x] Redaction and bounded-output regressions covered
- [x] Tests, typecheck, build, and diff checks passed
- [ ] Feature branch and PR handoff verified

## Validation results

- Focused checkpoint/live-run suite — passed, 16 tests.
- `npm test` — passed, 92 tests, 0 failures.
- `npm run typecheck` — passed.
- `env NODE_ENV=production npm run build` — passed. Next reported the existing non-fatal NFT tracing
  warning through `next.config.mjs`, `src/lib/server/workspaces.ts`, and the stop route.
- `git diff --check` — passed.