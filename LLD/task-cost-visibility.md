# LLD: Task Cost Visibility

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-21
- **Related task or issue:** [Issue #21](https://github.com/maxlee98/project-agent-control-plane/issues/21) — “There should be an associated cost for each task.”

## Problem and observed evidence

Tasks currently expose title, status, priority, agent state, and run history, but no cost estimate or
spend. The dashboard therefore cannot help a human compare the expected or accumulated agent spend
before starting work. Live Cline events are persisted as activity/run events, but the current adapter
does not expose provider usage or pricing, so the first implementation must use an explicit task cost
estimate rather than claim provider-billed actuals.

## Goals

- Store a non-negative USD cost estimate on every task, including existing and newly created tasks.
- Let humans set the estimate when creating a task and edit it from the task detail rail.
- Show the amount on task cards and in task details so it is visible while planning.
- Keep cost data local, redact-free, and independent from provider credentials.
- Preserve compatibility with existing SQLite databases through an additive migration.

## Non-goals

- Do not infer or present provider-billed actual spend without reliable Cline usage and pricing data.
- Do not add credentials, billing APIs, or a new external pricing service.
- Do not change run dispatch, GitHub synchronization, or task workflow behavior.
- Do not redesign unrelated dashboard surfaces.

## Requirements and acceptance criteria

1. `Task` has a numeric `estimatedCostUsd` field with a value of `0` or greater.
2. SQLite stores the value in cents as an integer (`estimated_cost_cents`) to avoid floating-point
   persistence errors; old databases default to zero.
3. New task creation accepts an optional non-negative USD estimate and rejects invalid values.
4. Task updates can change the estimate and reject invalid values without changing other fields.
5. The board card displays a recognizable USD amount for every task.
6. The detail rail displays the estimate and provides an accessible edit control.
7. Tests cover migration/default mapping, create/update persistence, and invalid input rejection.

## Existing architecture and affected boundaries

- `src/lib/domain.ts` defines the API/UI task contract.
- `src/lib/server/db.ts` owns SQLite schema creation, migrations, and seed data.
- `src/lib/server/repository.ts` maps and persists tasks.
- `src/app/api/tasks/route.ts` validates task creation input.
- `src/app/api/tasks/[taskId]/route.ts` validates task updates.
- `src/components/ControlPlane.tsx` renders cards, the task detail rail, and task creation UI.
- Existing Node tests import repository/database modules against isolated temporary SQLite databases.

## Proposed design and data/state transitions

Persist `estimated_cost_cents INTEGER NOT NULL DEFAULT 0` on `tasks`. The server maps cents to
`estimatedCostUsd` by dividing by 100. API input remains decimal USD for human-friendly forms; the
server trims, parses, validates finiteness/non-negativity, and rounds to the nearest cent before
writing. An omitted create value uses `$0.00`. An omitted update value leaves the existing estimate
unchanged. The UI sends a PATCH only after the user submits a valid non-negative number.

This is an estimate, not an actual invoice. Labels will use “Est. cost” and the detail copy will make
that distinction clear.

## Affected files and modules

- `LLD/task-cost-visibility.md` — durable design and validation record.
- `src/lib/domain.ts` — add the task cost field.
- `src/lib/server/db.ts` — schema/migration and seed defaults.
- `src/lib/server/repository.ts` — map, create, and update costs.
- `src/app/api/tasks/route.ts` — validate create cost input.
- `src/app/api/tasks/[taskId]/route.ts` — validate update cost input.
- `src/components/ControlPlane.tsx` — cost input and display.
- `tests/task-cost.test.ts` — persistence and validation regressions.

## Risks, edge cases, and rollback or recovery strategy

- Decimal precision: convert to integer cents at the server boundary; do not store floating point.
- Blank form input: treat it as `$0.00` on creation, but reject malformed nonblank input.
- Negative, NaN, or infinite input: return HTTP 400 and leave the task unchanged.
- Legacy database: additive default-zero migration is safe and reversible by reverting code; existing
  rows remain valid.
- The estimate may differ from a provider invoice. Explicit UI wording prevents presenting it as actual
  usage; provider telemetry can be a later, separate task.

## Validation plan

- Run the focused task cost test.
- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run `git diff --check`.
- Review the UI/API against the acceptance criteria and confirm no secrets or billing data are added.

## Decision log

- 2026-08-21: Use a per-task estimated USD amount because the current Cline adapter has no reliable
  usage/pricing event contract.
- 2026-08-21: Store integer cents in SQLite and expose decimal USD in the domain/API/UI.
- 2026-08-21: Default existing and newly created tasks to `$0.00`; this keeps the field present for
  every task without inventing a cost.

## Open questions and assumptions

- Assumption: “cost” means a human-maintained estimate for planning until provider usage telemetry is
  available.
- Open question: a future task should define provider/model price tables and actual-vs-estimated cost
  reconciliation.
- Canonical GitHub Issue identity was verified as Issue #21 before handoff.

## Validation results

- `npm install`: passed; installed project dependencies. npm reported 20 existing audit findings and
  Node 23 engine warnings for transitive packages; no package manifest changes were made.
- `npm test`: passed; 25 tests passed, 0 failed, including task cost parsing and persistence coverage.
- `npm run typecheck`: passed.
- `npm run build`: TypeScript and application compilation passed, but the existing Next/Turbopack build
  failed while prerendering `/_global-error` with `TypeError: Cannot read properties of null (reading 'useContext')`.
  It also reported the existing NFT tracing warning and React key warnings; no task-cost-specific
  diagnostic was reported.
- `git diff --check`: passed.
- Security review: no credentials, billing API calls, or sensitive data were added. Cost is explicitly
  presented as a local planning estimate rather than provider-billed spend.

## Completion checklist

- [x] Intake and design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests and typecheck passed; build reached prerendering but failed on an existing global-error/runtime issue
- [x] Documentation updated
- [x] Handoff verified locally; PR creation remains pending because the feature branch has not been pushed