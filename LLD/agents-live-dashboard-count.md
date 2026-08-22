# LLD: Agents Live Dashboard Count

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-19
- **Related task or issue:** GitHub Issue #42 — https://github.com/maxlee98/project-agent-control-plane/issues/42

## Problem

The dashboard's top-level `Agents Live` card is not reflecting agents as they are started. The
existing liveness implementation derives project counts from active Live Cline sessions. The
active-session registry is currently module-local, while the start-run and dashboard endpoints are
separately bundled server boundaries in Next.js. The dashboard endpoint can therefore consult a
different empty registry from the one populated by the run endpoint, leaving every `isActive` value
false even while Cline is working.

## Goals

1. Make the `Agents Live` card increment promptly when a real agent run becomes active.
2. Keep the count scoped to currently active Live runs and exclude Demo/history/stale rows.
3. Keep the card consistent with the API's project/run liveness projection.
4. Add a focused regression test for the discovered failure boundary.

## Non-goals

- Do not change the meaning of runtime liveness established by `agent-liveness-and-project-deduplication.md`.
- Do not add a distributed worker or websocket transport.
- Do not alter unrelated task, project, GitHub, or cost behavior.
- Do not merge the pull request automatically.

## Requirements and acceptance criteria

- Starting an agent causes the dashboard card to show the active agent within the existing polling
  interval or immediately after the start response, whichever is the repository's established UX.
- Stopping, completing, or failing an agent removes it from the card on the next dashboard update.
- Demo runs and persisted Live rows without a current-process active session remain excluded.
- A regression test fails on the old behavior and passes with the fix.
- Typecheck, tests, and build pass.

## Existing architecture and affected boundaries

- `src/components/ControlPlane.tsx` renders the card and polls `/api/dashboard`.
- `src/app/api/dashboard/route.ts` exposes the dashboard projection.
- `src/lib/server/repository.ts` maps runs and derives `activeAgents` from `isActive`.
- `src/lib/server/cline.ts` owns the current-process active Cline-session registry.
- `src/lib/server/orchestrator.ts` starts/stops demo and Live runs.
- Existing liveness regressions live in `tests/liveness.test.ts` and Live lifecycle coverage lives
  in `tests/live-run.test.ts`.

## Proposed design

Store the current-process Cline-session registry on `globalThis`, matching the repository's other
cross-route runtime registries. All server bundles in one process then share the same source of
truth. Preserve the existing `isActive` predicate and avoid duplicating liveness logic in the
client. Add a regression that populates the shared registry from one server boundary and verifies
the dashboard projection from another boundary sees the active run.

## Data and state transitions

1. Start request creates/updates a Live run as queued or running.
2. Cline startup registers the run's active session in the process-wide registry.
3. Dashboard projection in its server bundle reads that same registry, maps `isActive = true`, and
   increments its project count.
4. Client receives the refreshed projection and renders the count.
5. Stop/completion removes the session and/or changes status; the next projection decrements the count.

## Affected files and boundaries

- `src/lib/server/cline.ts`: share active Cline sessions through the process-wide runtime registry.
- `tests/liveness.test.ts`: verify dashboard liveness can observe a session registered across the
  server-boundary seam.
- `src/components/ControlPlane.tsx`: no change expected; it already renders `run.isActive` values
  returned by the dashboard API.

## Risks, edge cases, and rollback or recovery strategy

| Risk | Mitigation |
| --- | --- |
| Count briefly lags session startup | Use the existing polling/start response boundary and test timing deterministically. |
| Stale persisted rows are counted | Retain the current-process session requirement. |
| Multiple runs are double-counted | Count active runs once per run and preserve project scoping. |
| Fix changes Demo behavior | Keep Demo runs visibly separate and covered by existing tests. |

Rollback is a revert of the focused commit; no schema migration or destructive data operation is
expected.

## Validation plan

- Inspect and reproduce the start/dashboard state transition with focused tests.
- Run the targeted regression test.
- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run `git diff --check` and inspect the final diff.

## Decision log

- 2026-08-19: Created this task-specific LLD after confirming the repository already contains the
  broader liveness design and implementation.
- 2026-08-19: Reproduced the failure boundary: the dashboard and run routes can load separate
  module instances, so a module-local Cline registry is not process-wide. Use `globalThis` rather
  than changing the client metric or weakening stale-session protection.
- 2026-08-19: Implemented the process-wide registry and added a cross-module regression using a
  second Cline module instance; the repository dashboard observes the active run during the Cline
  turn and returns to zero after cleanup.

## Open questions and assumptions

- Assumption: Next.js route bundles may evaluate shared server modules independently; the registry
  must therefore be explicitly process-wide.

## Completion checklist

- [x] Design reviewed
- [x] Failure boundary reproduced
- [x] Implementation complete
- [x] Regression test added or updated
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] LLD updated with actual validation results
- [ ] PR template validated and PR remotely verified

## Validation results

- `npm test`: passed; 59 tests passed, 0 failed, including the new cross-server-module liveness
  regression.
- `npm run typecheck`: passed with no TypeScript diagnostics.
- `npm run build`: passed with `NODE_ENV=production DATA_DIR=/tmp/control-plane-build-42`; the
  default build initially hit a database lock from the workspace's existing local dev server, so
  validation used an isolated temporary data directory. Next reports one pre-existing NFT tracing
  warning from dynamic filesystem access in `next.config.mjs`/`src/lib/server/db.ts`.
- `git diff --check`: passed.
- Dependency setup: `npm install` was required because the isolated workspace initially lacked
  `node_modules`; npm reported existing audit vulnerabilities and Node 23 engine warnings for
  transitive packages. No dependency files changed.