# LLD: Restore the Reasoning Effort Selector

## Status

- **Status:** Implemented; pending human review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-23
- **Related task or issue:** [Issue #75](https://github.com/maxlee98/project-agent-control-plane/issues/75) — Restore the reasoning effort selector.

## Problem and observed evidence

Issue #35 added per-run reasoning effort support across the domain, API, repository, Cline adapter,
and dashboard. A later UI refactor removed the selector JSX from `DetailRail` while retaining the
`reasoningEffort` state, the configured capability data, and the Start/Continue request plumbing.
Operators therefore cannot select a supported non-default effort even though the backend still
accepts and persists it.

## Goals

- Restore a visible and accessible Reasoning effort selector in the selected task detail rail.
- Keep `Default / unset` as the safe initial choice.
- Render only values from `runtime.reasoning.supportedEfforts`.
- Preserve the existing selection state and Start/Continue request behavior.
- Add a regression test that protects presence, binding, default behavior, capability rendering, and
  placement before the run actions.

## Non-goals

- Do not change provider/model configuration or SDK capability discovery.
- Do not change API validation, run persistence, Cline startup forwarding, or cost accounting.
- Do not reconfigure an already-running session.
- Do not introduce a browser test framework for this focused UI restoration.

## Requirements and acceptance criteria

1. A selected task's detail rail visibly contains a labeled `Reasoning effort` dropdown.
2. The dropdown includes `Default / unset` and dynamically renders only supported capability values.
3. The dropdown is controlled by `reasoningEffort` and updates through `setReasoningEffort`.
4. The selector appears before the Start/Continue/Stop action controls.
5. When no explicit effort is available, the selector remains present and explains that the configured
   provider/model has no explicit choices.
6. Existing run-control behavior remains unchanged.
7. A repository test fails if the UI contract is removed or moved after the action controls.

## Existing architecture and affected boundaries

- `src/components/ControlPlane.tsx` owns the client-side task detail rail and already receives
  `runtime.reasoning`, owns `reasoningEffort`, and passes the selection to run callbacks.
- `src/lib/domain.ts` defines `ReasoningEffort`, `ReasoningCapability`, and `DashboardData.runtime`.
- `src/lib/server/reasoning.ts` normalizes SDK model metadata and fails closed to no explicit choices.
- `src/app/api/reasoning/route.ts` exposes configured capability metadata.
- `src/app/api/tasks/[taskId]/runs/route.ts` and the continuation/retry routes validate the selected
  value before creating a run.
- `tests/` uses Node's built-in test runner and has no browser rendering harness, so the focused UI
  guard is a source-level contract test consistent with other repository metadata tests.

## Proposed design

Insert one violet-accented panel in `DetailRail` immediately after the cost panel and before the run
action row. The panel contains:

- an explicit `<label>` associated with a stable `reasoning-effort` control ID;
- concise help text explaining that Default leaves model behavior unchanged;
- a controlled `<select>` with an empty value for Default/unset;
- options generated from `runtime.reasoning.supportedEfforts` rather than a hard-coded provider list;
- a provider/model hint, or a fail-closed message when no explicit options are available.

The existing `reasoningEffort` state is reset when the selected task changes. Start and Continue
callbacks continue to receive the selected value or `null`; no server boundary changes are needed.

Add `tests/reasoning-effort-ui.test.ts` to read the component source and assert the stable UI contract:
label and accessibility relationship, controlled state binding, Default option, dynamic capabilities,
empty-capability messaging, and ordering before the run action anchor. Existing reasoning tests
continue to cover SDK capability normalization and unsupported-value rejection.

## Data and state transitions

```text
Task selected -> DetailRail renders selector -> operator chooses Default or supported effort
                                                   |
                                                   +-> existing Start/Continue request
                                                       -> existing API/repository/Cline snapshot
```

There is no schema migration, new API field, new remote write, or change to the persisted run
snapshot. An empty selection remains `null`/unset at the existing boundary.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| UI exposes unsupported effort values | Generate options only from `runtime.reasoning.supportedEfforts`; retain server validation. |
| Provider exposes no explicit reasoning capability | Keep the selector present with Default/unset and a truthful explanatory message. |
| Selection leaks between tasks | Preserve the existing task-ID keyed reset effect. |
| Source-level test misses a browser-only issue | Keep the contract test narrow and require manual browser review during handoff; do not add a new test framework for this fix. |
| Restoration needs rollback | Revert the single panel insertion and its regression test; no data or API rollback is required. |

## Validation plan and results

- Focused reasoning and UI contract tests: passed, 4 tests.
- Full `npm test`: passed, 100 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed; Next.js reported the existing workspace-root/NFT tracing warning.
- `git diff --check`: passed.
- `node scripts/verify-hard-stop.mjs`: passed.
- Review the final diff for only the selector, regression test, and this LLD.

## Decision log

- 2026-08-23: Use the existing `DetailRail` state and runtime capability payload rather than adding
  another API or persistence path.
- 2026-08-23: Keep Default/unset rendered even when capability metadata is empty so the control remains
  discoverable and does not fabricate provider support.
- 2026-08-23: Use a source-level regression contract because the repository has no browser test
  harness; avoid introducing unrelated test infrastructure for a one-panel restoration.

## Completion checklist

- [x] Canonical Issue #75 verified before implementation handoff
- [x] Existing Issue #35 LLD reread and UI regression identified
- [x] Reasoning effort selector restored
- [x] Regression coverage added
- [x] Focused tests passed
- [x] Full tests, typecheck, build, diff check, and hard-stop verification passed
- [x] Pull request #76 created and verified for human review; Issue #75 remains open pending merge
