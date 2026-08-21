# LLD: Task Cost Visibility

## Status

- **Status:** Implemented; pending human review and merge
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-21
- **Related task or issue:** [Issue #21](https://github.com/maxlee98/project-agent-control-plane/issues/21) — “There should be an associated cost for each task.”

## Problem and observed evidence

Tasks currently expose title, status, priority, agent state, and run history, but the first Task #21
implementation only stores a manually entered estimate. It does not account for provider/model token
usage, so the dashboard cannot answer how much an agent run actually cost. The installed Cline SDK
provides normalized session usage and model-catalog pricing, but the current adapter drops both and
therefore cannot account for model changes or aggregate retries and continuations safely.

## Goals

- Preserve the non-negative USD estimate/budget on every task, including existing and newly created
  tasks.
- Capture provider-reported actual token usage and cost for every live run when available.
- Snapshot the provider and model used by each run; never re-price a completed run after configuration
  changes.
- Aggregate run actuals onto the task while keeping estimates and actuals visibly separate.
- Keep cost data local, redact-free, and independent from provider credentials.
- Preserve compatibility with existing SQLite databases through additive migrations.

## Non-goals

- Do not present a manual estimate as provider-billed actual spend.
- Do not add credentials, billing APIs, or a new external pricing service.
- Do not change run dispatch, GitHub synchronization, or task workflow behavior.
- Do not redesign unrelated dashboard surfaces.

## Requirements and acceptance criteria

1. `Task` has a non-negative `estimatedCostUsd` budget and an `actualCostUsd` value that is `null`
   until a priced usage result is available.
2. SQLite stores the estimate in cents (`estimated_cost_cents`) and actual spend in integer
   micro-dollars (`actual_cost_micros`) to avoid floating-point persistence errors; old databases
   default to zero estimate and no actual.
3. Each run stores its `provider_id`, `model_id`, token totals, cost source, and immutable actual cost
   snapshot. A later model change affects only later usage.
4. Cline usage totals are read from `ClineCore.getAccumulatedUsage(sessionId)`. If only token counts
   are available, the matching SDK model-catalog pricing is used; missing pricing is shown as
   unavailable rather than fabricated as zero.
5. New task creation and updates accept an optional non-negative USD estimate and reject invalid values.
6. The board card and detail rail distinguish `Est.` from `Actual`; the detail rail retains an
   accessible estimate edit control and the run console shows provider/model and token usage.
7. Tests cover migration/default mapping, exact pricing, model changes across runs, aggregation,
   missing pricing, create/update persistence, and invalid input rejection.

## Existing architecture and affected boundaries

- `src/lib/domain.ts` defines the API/UI task contract.
- `src/lib/server/db.ts` owns SQLite schema creation, migrations, and seed data.
- `src/lib/server/repository.ts` maps and persists tasks.
- `src/lib/server/cost.ts` — exact USD parsing and provider/model usage pricing helpers.
- `src/lib/server/cline.ts` — translates Cline usage into the normalized run accounting record.
- `src/lib/server/orchestrator.ts` — persists usage after normal, failed, and stopped live runs.
- `src/app/api/tasks/route.ts` validates task creation input.
- `src/app/api/tasks/[taskId]/route.ts` validates task updates.
- `src/components/ControlPlane.tsx` renders cards, the task detail rail, and task creation UI.
- Existing Node tests import repository/database modules against isolated temporary SQLite databases.

## Proposed design and data/state transitions

Persist `estimated_cost_cents INTEGER NOT NULL DEFAULT 0` on `tasks`. Persist actual run accounting
on `runs` with `provider_id`, `model_id`, token counters, `cost_source`, and
`actual_cost_micros`. The repository aggregates non-null run micro-dollar values for each task; it
does not overwrite historical runs when the configured provider or model changes.

The live Cline adapter reads `getAccumulatedUsage(sessionId)` after the session ends. Cline’s
`totalCost` is the authoritative provider/model-aware result when present. When a provider returns
tokens but no total, `cost.ts` applies the matching SDK catalog rates (which are dollars per million
tokens, including cache read/write rates). If no rates exist, the run remains explicitly unpriced.
The run record therefore preserves the model used and the source of the number, including across
retries and continuations.

API estimate input remains decimal USD for human-friendly forms; the server trims, parses, validates
finiteness/non-negativity, and rounds to the nearest cent before writing. An omitted create value uses
`$0.00`; an omitted update value leaves the estimate unchanged. UI labels use “Est. cost” and “Actual
cost” so neither is confused with the other.

## Affected files and modules

- `LLD/task-cost-visibility.md` — durable design and validation record.
- `src/lib/domain.ts` — add the task cost field.
- `src/lib/server/db.ts` — schema/migration and seed defaults.
- `src/lib/server/repository.ts` — map, create, and update costs.
- `src/lib/server/cost.ts` — exact estimate parsing and model-pricing calculation.
- `src/lib/server/cline.ts` — usage extraction from ClineCore.
- `src/lib/server/orchestrator.ts` — live-run usage persistence.
- `src/app/api/tasks/route.ts` — validate create cost input.
- `src/app/api/tasks/[taskId]/route.ts` — validate update cost input.
- `src/components/ControlPlane.tsx` — cost input and display.
- `tests/task-cost.test.ts` — persistence and validation regressions.

## Risks, edge cases, and rollback or recovery strategy

- Decimal precision: convert estimates to integer cents and actuals to integer micro-dollars at the
  server boundary; do not store floating point.
- Blank form input: treat it as `$0.00` on creation, but reject malformed nonblank input.
- Negative, NaN, or infinite input: return HTTP 400 and leave the task unchanged.
- Legacy database: additive default-zero migration is safe and reversible by reverting code; existing
  rows remain valid.
- Provider catalog pricing can become stale or differ from an invoice. Preserve the pricing source,
  provider, and model with each run and label catalog-derived values; prefer the SDK-reported total.
- A run with tokens but no known pricing is not silently recorded as `$0.00`; it remains unavailable.

## Validation plan

- Run focused pricing, usage extraction, and task aggregation tests.
- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run `git diff --check`.
- Review the UI/API against the acceptance criteria and confirm no secrets or billing data are added.

## Decision log

- 2026-08-21: The estimate-only implementation was insufficient because the installed Cline SDK
  exposes normalized usage, accumulated cost, and model pricing metadata.
- 2026-08-21: Store integer cents in SQLite and expose decimal USD in the domain/API/UI.
- 2026-08-21: Store actuals as integer micro-dollars and snapshot provider/model on each run. Model
  changes affect only new usage; prior runs are never re-priced.
- 2026-08-21: Prefer `ClineCore.getAccumulatedUsage` as the actual-cost source, use SDK catalog rates
  only as a fallback, and show missing pricing as unavailable.

## Open questions and assumptions

- Assumption: “cost” includes both a human-maintained planning estimate and provider/model-aware actual
  spend when the SDK supplies usage data.
- Open question: a future task may add invoice reconciliation if a provider offers billing exports.
- Canonical GitHub Issue identity was verified as Issue #21 before handoff.

## Validation results

- `node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/task-cost.test.ts`: passed; 5 tests passed, 0 failed.
- `npm test`: passed; 31 tests passed, 0 failed.
- `npm run typecheck`: passed.
- `npm run build`: passed; all routes compiled and prerendered. The existing Turbopack NFT tracing
  warning remains; no task-cost-specific warning was reported.
- `git diff --check`: passed.
- Security requirement: no credentials, billing API calls, or sensitive raw usage payloads may be
  persisted or added to GitHub comments.

## Completion checklist

- [x] Intake and design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, build, and diff checks rerun for the repair
- [x] Documentation updated
- [x] Handoff verified: commit `d3bc890e0ccb6a9459dc8a0097d1e003c371fe0d`, branch `agent/21-There-should-be-an-associated-cost-a2d20ec9`, PR #31 open at https://github.com/maxlee98/project-agent-control-plane/pull/31; fresh CI and PR-template checks passed