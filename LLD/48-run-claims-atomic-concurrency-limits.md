# LLD: Atomic Run Claims and Concurrency Limits

## Status
- Status: Complete; PR handoff pending
- Owner: Project Agent Control Plane
- Date: 2026-08-22
- Related task or issue: GitHub Issue #48 — https://github.com/maxlee98/project-agent-control-plane/issues/48

## Problem and observed evidence

`startAgentRun()` reads a task and checks `agentState` before `createRun()` writes the run and task
state. Concurrent requests can therefore both observe an idle task and create live runs. The dashboard
also presents a fixed `of 04 slots` label even though no global or per-project capacity is enforced.

## Goals

- Insert the run and its task claim in one SQLite transaction.
- Enforce configurable global and per-project limits for Live runs before dispatch.
- Return stable duplicate-claim (`409`) and capacity (`429`) error codes and safe messages.
- Release claims on completed, failed, and stopped runs, including operator stop and expired leases.
- Recover legacy/stale active rows without deleting run history.
- Expose configured and currently claimed Live capacity to the dashboard and render it in the UI.
- Preserve start, continue, retry, demo behavior, and existing run history.

## Non-goals

- No ClineCore, GitHub handoff, authorization, or distributed worker redesign.
- No cancellation of a healthy run to satisfy a new request.
- No per-user capacity policy.

## Requirements and acceptance criteria

- Concurrent claims for one task produce one run and one active claim.
- `AGENT_MAX_CONCURRENT_RUNS` and `AGENT_MAX_CONCURRENT_RUNS_PER_PROJECT` configure Live limits.
- Duplicate claims use `409` and `RUN_ALREADY_ACTIVE`; global/project capacity use `429` and stable
  capacity codes.
- Terminal transitions, operator stop, and expired leases remove the active claim and leave history.
- Existing active rows are migrated conservatively and expired on startup/recovery rather than silently
  being treated as healthy.
- Dashboard capacity reports actual claimed Live runs and configured limits; no hard-coded slot text
  remains.
- Tests cover duplicate races, global/project boundaries, terminal release, and lease recovery.

## Existing architecture and affected boundaries

- `src/lib/server/orchestrator.ts` owns start/continue/retry dispatch and terminal lifecycle paths.
- `src/lib/server/repository.ts` owns SQLite writes, task/run mapping, dashboard projection, and will
  become the atomic claim boundary.
- `src/lib/server/db.ts` owns additive SQLite schema/migrations.
- `src/app/api/tasks/[taskId]/runs/route.ts` and continue/retry routes expose run-start errors.
- `src/components/ControlPlane.tsx` renders the top-level Agents live metric.
- `tests/live-run.test.ts` covers injected lifecycle behavior; a focused run-claim suite covers the
  synchronous SQLite race and recovery paths.

## Proposed design

Add an `active_run_claims` table with one primary-key row per task, a unique run ID, project ID, claim
timestamps, and a lease expiry. `createRun()` runs recovery, duplicate detection, Live capacity
checks, run insertion, claim insertion, task update, and initial audit records in one better-sqlite3
transaction. SQLite's write serialization and the task primary-key claim constraint make the operation
atomic across concurrent requests in the process.

Only Live claims count against the configurable global and per-project limits. Demo runs still use the
same task claim invariant so a demo request cannot duplicate a task. Default limits retain the current
four-slot UI expectation while making them explicit: global `4`, per-project `2`.

Run terminal updates delete the claim in the same transaction as the status update. A recovery pass finds
expired queued/running claims, marks their run failed with a safe lease-expired error, returns a running
task to blocked/failed state, deletes the claim, and records a redacted failure event/activity. The
startup migration creates claims for legacy active rows, choosing the newest run per task, with an
immediately expired lease so stale rows recover safely on the next repository operation.

## Data and state transitions

1. Start request resolves optional source-run reasoning settings.
2. Repository transaction recovers expired claims, verifies the task, checks the task claim and Live
   limits, inserts the queued run and active claim, and marks the task running.
3. Orchestrator dispatches the claimed run. Live Cline/session liveness remains the existing separate
   `AgentRun.isActive` projection.
4. A completed, failed, or stopped `updateRun()` deletes the claim; the task retains its corresponding
   succeeded, failed, or waiting state.
5. A lease-expiry recovery marks the run failed and releases the task claim while preserving all prior
   run rows/events.
6. Dashboard recovery runs before projecting claimed capacity; UI displays active Live claims / global
   limit and configured per-project limit.

## Affected files and boundaries

- `LLD/48-run-claims-atomic-concurrency-limits.md`: durable design and validation record.
- `src/lib/server/db.ts`: active claim schema, indexes, and legacy active-row migration.
- `src/lib/server/repository.ts`: atomic claim result, config, recovery, release, capacity projection.
- `src/lib/server/orchestrator.ts`: consume atomic claim result and stable rejection values.
- `src/app/api/tasks/[taskId]/runs/route.ts`, `src/app/api/runs/[runId]/continue/route.ts`,
  `src/app/api/runs/[runId]/retry/route.ts`: map stable claim errors to HTTP status.
- `src/lib/domain.ts`: dashboard runtime capacity shape.
- `src/components/ControlPlane.tsx`: dynamic capacity detail and safe rejection notification handling.
- `.env.example`, `docs/security-model.md`: document operational configuration/guardrail.
- `tests/run-claims.test.ts`: duplicate, limit, release, and lease recovery coverage.

## Risks, edge cases, and rollback or recovery

| Risk | Mitigation |
| --- | --- |
| Existing duplicate active rows | Migration chooses one newest run per task and expires it for explicit recovery; history is retained. |
| Process crash leaves a claim | Lease expiry recovery marks the run failed and removes only the claim. |
| A healthy run outlives a lease | Default lease exceeds the configured maximum runtime; explicit lease configuration is operator-owned. |
| A limit is invalid or absent | Parse positive integer values and fall back to safe defaults. |
| Release fails after terminal update | Terminal update and deletion share one SQLite transaction. |
| API leaks provider details | Claim messages are fixed, safe vocabulary; existing redaction remains at event boundaries. |

Rollback is a code revert. The additive claim table and historical runs remain harmless; a future migration
can drop only claim enforcement after backing up local data if necessary.

## Validation plan

- Run the focused claim/recovery tests, then the full test suite.
- Run typecheck and production build separately.
- Run whitespace validation and inspect the final diff.
- Verify no real provider, GitHub, or worktree resources are started by the new tests.

## Decision log

- 2026-08-22: Verified canonical Issue #48 and selected an additive claim table rather than a partial
  task-state update so the run ID, task ownership, and capacity reservation share one transaction.
- 2026-08-22: Keep existing current-process Cline liveness semantics for `isActive`; capacity is based on
  durable active claims so queued dispatches reserve a slot immediately.
- 2026-08-22: Use process-local environment configuration with defaults (`4` global, `2` per project) for
  this ticket; database/project-specific policy is a follow-up for multi-worker execution.

## Open questions and assumptions

- Assumption: better-sqlite3 transactions provide the required local write serialization for concurrent
  in-process route requests and future local workers sharing the SQLite file.
- Assumption: the default claim lease can be derived from `AGENT_MAX_RUN_MINUTES` plus a one-minute
  recovery margin; `AGENT_CLAIM_LEASE_MINUTES` is available for operators/tests that need an explicit
  value.
- Follow-up: store per-project concurrency policy in SQLite when the control plane gains distributed
  workers or multi-user authorization.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] Documentation updated
- [ ] Handoff verified

## Review notes

- The durable claim is now the authoritative concurrency reservation; the existing Cline session
  registry remains the separate UI liveness signal.
- Terminal update/release operations are guarded against late demo callbacks and operator stop races.
- The branch refresh retained the claim-finalization helpers while incorporating current `main`'s
  canonical `human_review` handoff and historical LLD filename renames.

## Validation results

- Focused claim suite: passed; 3 tests covering duplicate request ownership, project/global limits,
  configured dashboard capacity, terminal release, and expired-lease recovery.
- `npm test`: passed; 91 tests passed, 0 failed, including the LLD naming contract after the branch
  refresh.
- `npm run typecheck`: passed with no TypeScript diagnostics.
- `npm run build`: passed with an isolated `DATA_DIR` and `NODE_ENV=production`; Next reported only
  the existing NFT tracing warning for dynamic filesystem access in `next.config.mjs`/server code.
- `git diff --check`: passed before and after the branch refresh.
- Branch refresh: merge commit `8612059` incorporated current `origin/main`, including the approved
  historical LLD renames, while preserving Issue #48's atomic claim implementation.
- Remote handoff: pending the required push, freshness verification, PR-template validation, and PR
  creation through `scripts/create-pr.mjs`.