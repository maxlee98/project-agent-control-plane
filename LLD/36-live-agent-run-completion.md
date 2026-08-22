# LLD: Diagnose and Complete Live Agent Runs

## Status

- **Status:** Complete; PR #39 open for human review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** GitHub Issue #36 — [Diagnose and make live agent runs complete successfully](https://github.com/maxlee98/project-agent-control-plane/issues/36)

## Problem and observed evidence

Live runs cross several asynchronous boundaries: local worktree preparation, ClineCore session
startup and turn execution, watchdogs and operator stop, repository checks, Git commit/push, PR
creation, and the optional Issue comment. Issue #36 requires a repeatable diagnosis and a successful
end-to-end path without false success, lost cost usage, or an unusable workspace after failure.

The current `src/lib/server/cline.ts` calls `ClineCore.start()` with the task prompt and then waits
for a second completion promise. The installed `@cline/core@0.0.75` runtime instead creates the
session in `start()` and executes a prompt during that call only when the prompt is supplied to the
local host; the transport-neutral host contract exposes `runTurn`/`cline.send({ sessionId, prompt })`
as the explicit execution boundary and returns an `AgentResult` with `finishReason`, output, and
usage. The current adapter does not reliably use the returned terminal result, registers the active
session only after startup resolves, and treats any `done` event as success. This can make startup
timeouts cover the whole run, make `stopClineRun()` unable to find the active session, and allow
aborted/error/max-iteration outcomes to reach repository handoff.

The orchestrator also stores some failure/check output without an explicit stage classification and
can persist an unredacted thrown error in the run record. Optional Issue-comment handling is intended
to be a warning after the PR is complete, but it lacks an end-to-end regression test.

## Goals

1. Establish and execute Cline sessions through the SDK's actual two-phase lifecycle.
2. Make startup, active-session liveness, inactivity/max-duration watchdogs, and operator stop
   behavior observable and bounded.
3. Require a successful Cline terminal result before checks and GitHub handoff.
4. Record stage-start/failure diagnostics with redacted actionable errors and preserve failed
   workspaces for inspection.
5. Prove a mocked successful live run persists events, task review state, PR identity, and cost usage.
6. Prove optional post-handoff Issue failures leave a completed/review-ready run and are recorded as
   warnings rather than converted to blocked/failed state.

## Non-goals

- Do not redesign the Cline event vocabulary; retain the adapter boundary tracked by #22.
- Do not replace the isolated-worktree design tracked by #26.
- Do not implement periodic Issue checkpoints tracked by #18.
- Do not add external observability, billing, or distributed worker services.
- Do not remove failed workspaces automatically or expose credentials/raw provider payloads.

## Requirements and acceptance criteria

- `ClineCore.start()` establishes a session without conflating startup and task-turn completion;
  the adapter registers the returned session before executing the turn.
- The task turn is executed through the SDK's explicit send/run-turn boundary and its returned
  terminal result is interpreted. Only `finishReason === "completed"` proceeds to checks/Git handoff;
  aborted, error, mistake-limit, max-iteration, and missing results fail closed.
- Startup, total-duration, inactivity, and operator stop paths stop/abort the active session when a
  session ID is available; the active-session registry is populated while the turn is running.
- The orchestrator records stage-start and stage-failure events for configuration/workspace/Cline/
  validation/Git/PR/Issue-update boundaries, with redacted error details in run/task/activity state.
- Validation output and thrown errors do not persist provider credentials, tokens, or authorization
  headers; failed workspaces remain available for inspection.
- A mocked live run reaches completed/review-ready state with persisted run events, task state, PR
  identity, and provider/model cost usage intact.
- An optional Issue-comment failure after PR creation leaves the run completed and task in
  `agent_review`, records a warning event/activity, and does not trigger a false retry/failure.
- Tests, typecheck, build, and a documented live-run verification procedure pass.

## Existing architecture and affected boundaries

- `src/lib/server/cline.ts`: ClineCore session/turn lifecycle, event translation, usage, timeout,
  active-session registry, and stop behavior.
- `src/lib/server/orchestrator.ts`: live stage sequencing, task/run state, validation/Git/PR/Issue
  handoff, and failure persistence.
- `src/lib/server/workspaces.ts`: checkout validation, isolated worktrees, checks, output capture,
  commit/push, and failed-workspace preservation.
- `src/lib/server/repository.ts`: local run/task/event/activity source of truth and liveness projection.
- `src/lib/server/github.ts`: PR creation/recovery and optional Issue-comment boundary.
- `src/lib/server/redaction.ts`: secret redaction at persistence boundaries.
- `tests/live-run.test.ts`: new isolated mocked end-to-end live-run and failure-boundary coverage.
- `docs/architecture.md`: documented bounded Live-mode verification procedure.
- Related existing LLDs: the pre-issue-tracking legacy document
  `LLD/agent-liveness-and-project-deduplication.md`, `LLD/21-task-cost-visibility.md`, and
  `LLD/28-issue-linked-pr-handoff.md`.

## Proposed design

### Two-phase Cline adapter

The adapter will:

```text
create core -> subscribe -> start session without prompt -> register session
            -> send task prompt -> consume AgentResult/events -> report usage -> dispose
```

The startup timeout covers only `start()`. The total deadline is calculated before startup and
limits the subsequent turn. The inactivity watchdog can stop the registered session during the
turn. The adapter will use the returned `AgentResult` as the authoritative terminal result and use
the event `done` payload only as a fallback when a host returns no result. Non-completed or missing
results become explicit errors containing the finish reason, without forwarding raw payloads.

### Stage diagnostics and redaction

The orchestrator will maintain a typed live-run stage and emit a bounded `stage_started` event when
entering each external boundary. The catch path emits `stage_failed`, persists a redacted error,
and retains the existing `run_failed`/blocked task behavior. Validation output will be redacted
before it enters the checks JSON. The optional Issue comment remains inside its own warning boundary:
PR/task/run completion is persisted first, then a comment failure emits `handoff_comment_failed` and
an activity warning without changing completed state.

### Testability seam

The orchestrator's live executor will accept a small internal dependency bundle with production
functions as defaults. Tests can provide deterministic workspace, Cline, validation, Git, PR, and
comment adapters while using isolated SQLite repository state. This verifies state transitions and
persisted evidence without credentials, real model calls, filesystem worktrees, or remote writes.

## Data and state transitions

No schema migration is required. The intended run state is:

```text
queued -> configuration -> workspace -> cline session/turn -> validation -> git -> PR
                                                               \-> failure: failed + blocked + preserved workspace
PR -> completed + agent_review -> optional Issue comment
                              \-> comment failure: completed + agent_review + warning
```

The Cline session registry is process-local and exists only while the session is active. SQLite
remains the durable source of task/run/event/activity state; a persisted running row alone is not
proof that a session is alive.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| SDK host returns a session but no turn result | Fall back to the typed `done` event once; fail closed if neither result is available. |
| Cline emits a non-completed terminal reason | Stop before checks/Git handoff and persist the finish reason as a redacted Cline-stage failure. |
| Stop/timeout races with terminal events | Make terminal resolution idempotent, unregister in `finally`, and ignore late events after disposal. |
| Startup fails before a session ID exists | Dispose the core and persist a configuration/Cline startup failure; no stop call is attempted with an empty ID. |
| Check output includes a secret or token-shaped value | Apply `redactSecrets` before storing output and before activity/event persistence. |
| Commit/push or PR succeeds before a later error | Keep the workspace and persisted handoff evidence; optional Issue comments are warnings after completion. |
| Retry sees an existing branch/PR | Preserve existing GitHub idempotent PR lookup/recovery and test the optional-comment retry boundary separately. |
| Tests accidentally mutate `.data` or call GitHub | Use temporary `DATA_DIR`, injected dependencies, and mocked adapters; no network is required. |

Rollback reverts the adapter/orchestrator/workspace/test/docs changes. Failed worktrees and local
SQLite state are not deleted by rollback.

## Validation plan

1. Run focused Cline adapter and live orchestrator tests with fake SDK/dependency boundaries.
2. Run redaction and existing liveness/cost/GitHub regression tests.
3. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` through `safe-run`.
4. Read back the LLD and changed lifecycle files; inspect that no credentials or environment files
   were read or changed.
5. Perform the bounded Live-mode verification documented in `docs/architecture.md` only when
   credentials/workspace configuration are explicitly available; otherwise record the mocked
   end-to-end result and the live prerequisite.

## Decision log

- 2026-08-22: Confirmed from `@cline/core@0.0.75` types and bundled runtime that session creation and
  task-turn execution are distinct `startSession` and `runTurn` operations; the adapter must not
  treat `start()` as the complete live run.
- 2026-08-22: Use the SDK's returned `AgentResult.finishReason` as the terminal authority and fail
  closed for non-completed or missing results instead of inferring success from any `done` event.
- 2026-08-22: Add dependency injection at the live executor boundary so end-to-end state tests are
  deterministic and do not require provider credentials or remote GitHub writes.
- 2026-08-22: Keep Issue comments optional after persisted PR completion; a comment failure is a
  warning and must never downgrade a completed review handoff.
- 2026-08-22: Require every subscribed session event to carry the registered session ID before it
  can update liveness or resolve completion; this prevents a shared host's unrelated event from
  completing or timing out the active task run.

## Open questions and assumptions

- Assumption: `ClineCore.send({ sessionId, prompt, mode })` remains the public SDK shape for the
  installed version; the implementation will compile against the installed type definitions.
- Assumption: the run's max-duration deadline includes session startup and turn execution, while the
  startup timeout remains a separate diagnostic label.
- Open question: a future runtime enforcement layer may expose richer stage status in the domain API;
  this task uses persisted event/activity types without a schema migration.

## Validation results

- SDK contract inspection: verified `@cline/sdk@0.0.75` exposes separate `start()` session setup and
  `send({ sessionId, prompt, mode })` turn execution, with optional `AgentResult`/`undefined` results;
  the adapter uses the returned result authoritatively and falls back to the matching session's
  terminal event only when no result is returned.
- Focused Issue #36 suite: passed, 8 tests, including the foreign-session terminal-event regression.
- Full repository validation: passed, 50 tests, 0 failures; `npm run typecheck` completed without
  diagnostics; `npm run build` completed successfully with the existing non-fatal Turbopack NFT
  tracing warning through `next.config.mjs`, `src/lib/server/db.ts`, and the retry route; and
  `git diff --check` passed.
- Live verification: the bounded procedure is documented in `docs/architecture.md` and the
  network-free mocked end-to-end path passed. A real provider/GitHub run was not executed because
  live credentials and a target checkout were not explicitly provided for this handoff.
- PR handoff: PR #39 is open against `main` from `fix/36-live-run-completion`, contains the required
  `Fixes #36` linkage and canonical template headings, and passed the remote freshness check before
  creation. Human review and merge remain pending.

## Completion checklist

- [x] Intake and design reviewed
- [x] Cline two-phase lifecycle implemented
- [x] Stage diagnostics and redaction implemented
- [x] Mocked successful/failure-boundary tests added
- [x] Tests, typecheck, build, and diff checks passed
- [x] Live-run verification procedure documented or executed
- [x] Dedicated branch and PR handoff verified