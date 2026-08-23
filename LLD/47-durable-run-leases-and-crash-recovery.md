# LLD: Durable Run Leases and Crash Recovery

## Status
- Status: In progress
- Owner: Project Agent Control Plane
- Date: 2026-08-23
- Related task or issue: [Issue #47](https://github.com/maxlee98/project-agent-control-plane/issues/47)

## Problem and observed evidence
Live run ownership currently exists only in process memory while SQLite retains queued/running run
rows. A server or worker crash can therefore leave a task projected as running even though no worker
can continue it. The existing `isActive` projection correctly ignores missing in-process sessions,
but it does not repair the durable run or task state.

## Goals
- Persist a per-run owner identity, lease heartbeat, expiry, and last-known stage.
- Renew the lease while a Live run is active and prevent healthy leases from being stolen.
- Reconcile expired leases at startup and through a bounded explicit recovery check.
- Record a redacted interrupted recovery outcome and return the task to a safe blocked/failed state
  without claiming success.
- Keep stop, continue, and retry deterministic after process restart while preserving workspaces and
  history.

## Non-goals
- Inferring completion from progress or missing ownership.
- Deleting failed worktrees or run history.
- Multi-user authorization, hosted worker isolation, or replacing Cline/GitHub handoff semantics.

## Requirements and acceptance criteria
- Live runs expose durable owner identity, heartbeat/last-seen, expiry, and current stage.
- Expired ownership is recovered idempotently with a fixed, redacted diagnostic and finish time.
- Recovered task projections do not remain `agentState = running` and no longer block a safe retry or
  continue operation.
- Atomic lease renewal/claim rules do not steal a healthy lease.
- Tests cover startup/crash recovery, renewal, expiry races, deterministic restart controls, and
  preserved workspaces.

## Existing architecture and affected boundaries
- `src/lib/server/db.ts` owns additive SQLite schema setup and legacy migration.
- `src/lib/server/repository.ts` owns run/task persistence, active claims, and API projections.
- `src/lib/server/orchestrator.ts` owns Demo scheduling and Live stage transitions.
- `src/lib/server/cline.ts` owns the current-process Cline session map and callbacks.
- Run control routes call the orchestrator; response shape remains compatible while exposing recovered
  run data through the existing run projection.

## Proposed design
Add nullable/legacy-safe lease columns to `runs`: `owner_id`, `lease_heartbeat_at`,
`lease_expires_at`, and `current_stage`. A conservative default lease is five minutes, renewed roughly
every third of the lease interval (both configurable through positive environment values). Each Live dispatch gets a process
owner ID and atomically claims the run only when no unexpired owner exists. Renewal and stage updates
are conditional on matching the owner and active run status.

On database initialization, and from a bounded recovery interval, the repository scans at most the
configured batch size for queued/running Live runs whose lease has expired. Each row is atomically
changed to `failed`, with `finished_at`, a fixed redacted interruption error, and cleared ownership;
the associated task is changed to `blocked`/`failed` with a continuation-oriented summary. A unique
recovery event/activity is written in the same transaction. Recovery only updates rows still active
and still expired, so a concurrent renewal or prior recovery is harmless.

The orchestrator claims a Live run before dispatch, updates its stage alongside existing activity,
renews on a timer and on Cline callbacks, and releases ownership when finishing/stopping. Startup
recovery runs when the orchestrator module initializes, with an exported bounded check for tests and
future worker integration. Existing workspaces remain untouched.

## Data and state transitions
```text
queued/running + unexpired owner -> renew / stage update -> queued/running
queued/running + expired lease -> failed(interrupted) + finished_at + no owner
                                                task -> blocked/failed, workspace preserved
active run + operator stop -> stopped + finished_at + no owner
recovered failed run -> continue/retry creates a new run after normal claim checks
```

Lease writes use server-generated ISO timestamps. A run owner is an opaque process-local identifier,
not a credential or user identity. Recovery diagnostics are fixed text and all persisted exceptions
continue through existing redaction boundaries.

## Affected files and boundaries
- `LLD/47-durable-run-leases-and-crash-recovery.md` — durable design and validation record.
- `src/lib/domain.ts` — run lease/stage/recovery representation.
- `src/lib/server/db.ts` — additive lease migration/index.
- `src/lib/server/repository.ts` — claim, renew, stage, release, recovery, and projection repair.
- `src/lib/server/cline.ts` — optional heartbeat callback hook from agent activity.
- `src/lib/server/orchestrator.ts` — owner lifecycle, stage transitions, startup recovery, and stop.
- `tests/run-claims.test.ts` — isolated persistence, race, restart, and recovery coverage.
- `tests/live-run.test.ts` — compatibility regression for Live lifecycle where needed.

## Risks, edge cases, and rollback or recovery strategy
- Clock skew is minimized by comparing server-side SQLite timestamps and using a conservative lease;
  a short lease is rejected by configuration normalization.
- Renewal after completion is harmless because status and owner conditions reject it.
- Recovery is idempotent and never removes a workspace; rollback can leave the additive columns and
  preserve all existing run history while disabling new lease writes.
- A process crash before claim leaves a queued row recoverable; a crash after claim is recovered after
  expiry. A healthy owner cannot be stolen by recovery.

## Validation plan
- Run focused run-lease tests with temporary SQLite databases.
- Run existing Live/liveness tests and the full test suite.
- Run typecheck, production build, and `git diff --check`.
- Inspect the additive migration against a legacy database fixture.

## Decision log
- 2026-08-23: Use startup reconciliation plus an exported bounded recovery check rather than a new
  worker, keeping this ticket compatible with the current Next process and future orchestration.
- 2026-08-23: Use `failed` with explicit interruption text and task `blocked` as the truthful recovery
  outcome; preserve existing stop semantics and workspaces.

## Open questions and assumptions
- The Next process is the initial recovery host; a later durable worker may call the same bounded
  repository operation.
- No verified hosted-worker identity is available, so the owner ID is generated per process and is
  only used for lease fencing.

## Validation results
- Focused lease/claim suite: passed; 4 tests covering atomic ownership, configured capacity, terminal
  release, expiry recovery, lease metadata, healthy renewal fencing, and retry after simulated restart.
- `npm test`: passed; 96 tests passed, 0 failed.
- `npm run typecheck`: passed with no TypeScript diagnostics.
- `npm run build`: passed with the existing non-fatal Turbopack NFT tracing warning for dynamic
  filesystem access in `next.config.mjs`/server code.
- `git diff --check`: passed.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests and typecheck passed
- [x] Production build passed with existing warning documented
- [x] Documentation updated
- [ ] Handoff verified