# LLD: Agent Liveness and Project Deduplication

## Status

- **Status:** In progress
- **Owner:** Project Agent Control Plane
- **Last updated:** 2026-08-19
- **Related repository:** `maxlee98/project-agent-control-plane`

## Problem

The dashboard currently renders persisted task/run state as if it were proof of a
running agent. The seeded project contains `run-seed-live-overview` with
`execution_mode = demo`, `session_id = cline-demo-seed`, and an illustrative
workspace path. Because project metrics count any task with `agent_state = running`,
the UI can display `1 live` even when no Next server, Cline session, process, or Git
worktree exists.

The local SQLite database also contains two project records pointing at the same
checkout:

- Seed/demo record: `maxlee/project-agent-control-plane`
- User-added record: `maxlee98/project-agent-control-plane`

Their GitHub names differ, but their normalized local checkout paths are identical.

## Goals

1. Make `live` mean an active Live run with a Cline session in the current server process.
2. Make seeded fixtures visibly Demo-only and never count them as Live agents.
3. Make project registration idempotent by normalized local checkout path.
4. Reconcile existing duplicate project records without losing tasks, runs, or activity.
5. Keep Demo mode useful for UI exploration while making Live mode operationally truthful.
6. Preserve durable design context in this document for future agents and context recovery.

## Non-goals

- Do not delete task, run, event, or activity history.
- Do not rotate, print, or persist provider credentials here.
- Do not introduce a distributed worker queue in this change.
- Do not replace ClineCore or the local SQLite architecture.
- Do not automatically merge or close GitHub issues/PRs.

## Proposed behavior

### Project visibility

- Add a persisted `is_demo` flag to projects.
- Known seeded projects are marked Demo.
- In Live mode, Demo fixture projects are hidden from the project registry and board.
- In Demo mode, Demo fixtures remain available for UI exploration.

### Agent liveness

- A project `activeAgents` count is derived from runs with:
  - `execution_mode = live`
  - `status IN ('queued', 'running')`
  - an active Cline session in the current process
- API run projections expose `isActive` using the same current-process Cline-session rule so the UI
  cannot infer liveness from persisted status alone.
- A persisted row alone is never sufficient to show `live`.
- A Demo run is rendered as `Demo run` / `Demo sample`, not `Live run`.
- The seeded sample task/run is migrated to a completed Demo sample.

### Project registration

- Normalize `~/...` and absolute local paths with `path.resolve`.
- If a project with the same `full_name` or normalized local path exists, return it
  instead of inserting another project.
- If the matching record is a Demo fixture, promote it to the user-supplied repository
  identity rather than creating a second row.

### Existing duplicate migration

At database initialization:

1. Add `projects.is_demo` if the column is missing.
2. Mark known seeded project IDs as Demo.
3. Group projects by normalized local path.
4. Choose a non-Demo project as canonical when one exists.
5. Move duplicate tasks, runs, and activity to the canonical project.
6. Delete only the redundant project row.

This migration is intentionally local and deterministic. The `.data/control-plane.db`
file should be backed up before applying it in a production deployment.

## Files and boundaries

- `src/lib/domain.ts`: project Demo metadata.
- `src/lib/server/paths.ts`: normalized local path helper.
- `src/lib/server/db.ts`: schema migration, seeded fixture conversion, duplicate reconciliation.
- `src/lib/server/repository.ts`: project idempotency, visible-project filtering, live-session metrics.
- `src/lib/server/cline.ts`: active Cline session registry query.
- `src/components/ControlPlane.tsx`: truthful Demo/Live labels, Demo fixture labels, and Live-only metrics.
- `tests/liveness.test.ts`: isolated SQLite migration, registration, and stale-session regressions.
- `tests/extensionless-loader.mjs`: Node test-loader support for the existing extensionless source imports.
- `package.json`: run the full test suite with the loader.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A stale Live row remains after a process crash | Require an active in-memory Cline session for `activeAgents`; preserve row for recovery. |
| Duplicate migration loses work | Reassign tasks/runs/activity before deleting only the duplicate project row. |
| Demo data disappears unexpectedly | Hide Demo fixtures only in Live mode; keep them in Demo mode. |
| Existing databases lack `is_demo` | Use an additive `ALTER TABLE` migration with a default. |
| Registration compares `~/` and absolute paths incorrectly | Normalize both paths before comparison. |

## Validation plan

- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Start the app in Live mode and verify the dashboard shows no Demo fixture as Live.
- Verify the current duplicate checkout produces one canonical project after startup.
- Verify a real Live run increments `activeAgents` only while its Cline session exists.
- Stop the server and confirm no project remains falsely marked `live`.

## Decision log

- 2026-08-18: The first apparent Live agent was confirmed to be seeded Demo data, not Cline execution.
- 2026-08-18: The duplicate project records were confirmed to share the same local checkout path.
- 2026-08-18: Runtime liveness is defined by current-process Cline session state, not only SQLite status.
- 2026-08-19: Added an `AgentRun.isActive` projection so server metrics and client metrics share one truthful liveness boundary.
- 2026-08-19: Duplicate reconciliation runs in one SQLite transaction and reassigns tasks, runs, and activity before deleting only redundant project rows.
- 2026-08-19: Node regression tests use isolated temporary `DATA_DIR` databases; no repository `.data` state is mutated by tests.

## Validation results

- `npm test`: passed; 6 tests passed, 0 failed. This includes path normalization, duplicate child-history preservation, Demo seed migration, Demo promotion/idempotent registration, and persisted Live-row stale-session behavior.
- `npm run typecheck`: completed without TypeScript diagnostics; follow-up process inspection found no active `tsc` process.
- `npm run build`: passed; Next.js compiled, finished TypeScript, generated 5 static pages, and finalized route optimization.
- Live dashboard check: a bounded temporary server on port 3123 returned Live mode with no Demo fixtures visible in `/api/dashboard`.
- Cleanup: port 3123 had no listener after the check; temporary database, response, log, and verification script were removed.
- Known warning: Next/Turbopack reports one non-fatal NFT tracing warning through `next.config.mjs` and `src/lib/server/db.ts`; it is outside this task’s scope.

## Completion checklist

- [x] Add/migrate `is_demo`.
- [x] Reconcile duplicate project records and preserve child history.
- [x] Filter Live metrics to active Live Cline sessions.
- [x] Update Demo/Live UI labels.
- [x] Add regression tests.
- [x] Validate Demo and Live dashboard behavior.
- [ ] Update this LLD with final commit/PR and verification results.