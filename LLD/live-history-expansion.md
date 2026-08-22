# LLD: Expandable Live History

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** GitHub Issue #20 — https://github.com/maxlee98/project-agent-control-plane/issues/20

## Problem

Each selected issue can show its latest run in the detail rail, but the run console is constrained by
the rail width and uses compact text sizing. This makes the live event trace and execution context
difficult to inspect. There is no per-issue affordance to open that history in a larger view.

## Goals

1. Add a clearly labeled button to the run console shown for the selected issue.
2. Open the issue’s current/live run history in a large, readable modal without fetching a second or
   different source of data.
3. Preserve the existing compact detail-rail console and its live polling behavior.
4. Make the expanded view keyboard- and screen-reader-friendly, including Escape-to-close, focus
   restoration, and a labelled dialog.

## Non-goals

- Do not change run persistence, event ordering, polling, or server/API contracts.
- Do not add a separate history route or a new database query.
- Do not change the meaning of Demo, Live, or Live history labels.
- Do not redesign unrelated task detail, board, or modal flows.

## Requirements and acceptance criteria

- When an issue has a current run, its run console includes a visible “Open live history” (or
  equivalent run-history) button.
- Activating the button opens a modal associated with that issue and run.
- The modal has substantially more horizontal and vertical space, readable event and metadata text,
  and a scrollable body for long histories.
- The modal can be closed with its close button, backdrop interaction, or the Escape key, and focus
  does not remain trapped behind the modal via page scrolling.
- Changing the selected issue closes any open history modal so stale issue context is not shown.
- Existing compact rendering remains available in the detail rail and current run data remains the
  only source of truth.
- TypeScript, tests, production build, and whitespace validation pass.

## Existing architecture and affected boundaries

- `src/components/ControlPlane.tsx` owns the client dashboard, selected issue state, detail rail,
  `RunConsole`, and existing modal conventions.
- `src/components/icons.tsx` owns the small SVG icon vocabulary used by the UI.
- `src/app/globals.css` owns the existing modal backdrop treatment and scrolling primitives.
- `/api/dashboard` already supplies the selected issue’s runs and run events through `DashboardData`;
  no API or persistence boundary is required.

## Proposed design

Keep `RunConsole` as the shared presentation for both compact and expanded views. Add an optional
expand callback and expanded rendering mode. The compact header exposes an icon-plus-label action;
the expanded modal invokes the same console with larger typography, a taller event trace, and more
complete bounded lists.

Add a `RunHistoryModal` beside the existing generic `Modal`. It receives the selected task, current
run, and already-filtered events from `DetailRail`, renders a labelled `role="dialog"`, and closes
on its explicit close button, backdrop click, or Escape. While open, preserve the previous body
overflow value and disable document scrolling; restore it on unmount. `DetailRail` owns the boolean
open state and resets it when the selected task changes.

## Data and state transitions

1. Dashboard polling refreshes `runs` and `runEvents` as it does today.
2. `DetailRail` derives `currentRun` and `currentEvents` from the refreshed dashboard projection.
3. The user activates the run console’s expand action; `historyOpen` becomes true.
4. The modal renders the same `currentRun` and `currentEvents` references in expanded mode.
5. Polling updates the parent data while the modal is open, so the expanded console reflects the
   latest event history without a second request.
6. Close, Escape, backdrop click, or task selection change sets `historyOpen` false.

## Affected files and boundaries

- `src/components/ControlPlane.tsx`: add expanded run-console presentation, modal behavior, and
  per-detail-rail open state.
- `src/components/icons.tsx`: add an expand/maximize icon if the existing vocabulary does not
  provide an appropriate affordance.
- `LLD/live-history-expansion.md`: record design decisions and actual validation results.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| A long event history exceeds the viewport | Modal body uses bounded height and the existing styled scrollbar. |
| User changes issue while the modal is open | Reset modal state on task identity changes and derive content from current props. |
| Escape listener or body lock leaks | Install both in one effect and restore/remove them in its cleanup. |
| Compact console becomes harder to scan | Keep the existing compact mode and only enlarge when the modal is opened. |
| Run completes while modal is open | Continue using polled `AgentRun`/`RunEvent` props; no new lifecycle or mutation is introduced. |

Rollback is a focused revert of the UI/icon/LLD changes. No schema, API, or remote side effects are
introduced.

## Validation plan

1. Inspect the final diff for focused UI changes and accessibility attributes.
2. Run `npm test`.
3. Run `npm run typecheck`.
4. Run `npm run build`.
5. Run `git diff --check`.
6. Verify branch freshness and the required PR template before any PR write; verify the resulting
   remote PR metadata afterward.

## Decision log

- 2026-08-22: Reuse the existing `RunConsole` and dashboard projection instead of introducing a
  second history endpoint, keeping the expanded view live with the existing 4.5-second polling.
- 2026-08-22: Use a purpose-built expanded dialog rather than making the detail rail wider, because
  the request is an optional readability mode and the board/detail layout should remain stable.
- 2026-08-22: Keep the modal state local to `DetailRail`; the selected task already defines the
  relevant run and events, and task changes must invalidate the open view.

## Open questions and assumptions

- Assumption: “for each issue” means the selected issue’s current/latest run shown in its detail rail,
  not a new board-level history picker.
- Assumption: the existing dashboard event limit is sufficient for this first expanded view; the
  modal can display all events already supplied by the dashboard without changing server limits.
- Canonical GitHub Issue #20 was verified with `gh issue view 20`; it is open and matches this task.

## Completion checklist

- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed (isolated DATA_DIR build)
- [x] Documentation created
- [ ] Handoff and remote PR verified

## Validation results

- `npm install`: passed; installed dependencies. npm reported existing audit vulnerabilities and
  Node 23 engine warnings for transitive packages; no dependency files changed.
- `npm run typecheck`: passed with no TypeScript diagnostics.
- `npm test`: passed; 68 tests passed, 0 failed.
- `npm run build`: compiled successfully and completed TypeScript, but failed during prerendering
  `/_global-error` with an existing `useContext` null error. Next also reported the existing NFT
  tracing warning and framework key warnings; no new compile or type errors were reported.
- `git diff --check`: passed.

## Handoff notes

- Implementation remains local on dedicated branch `agent/20-There-should-be-a-button-to-open-t-5d74ef51`.
- Canonical Issue #20 verified as open with the matching title and description. PR creation remains
  pending final branch/commit checks.