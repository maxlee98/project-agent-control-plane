# LLD: Clear Stale Agent State on Human Done

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-19
- **Related task:** `task-d86af9b1-d0bc-45af-b0d6-2858b37dc898`
- **Related GitHub Issue:** [Issue #10](https://github.com/maxlee98/project-agent-control-plane/issues/10)
- **Related project:** `project-25b20695-f8eb-49d3-ad9c-7ce6e7655f29` (`maxlee98/project-agent-control-plane`)

## Problem

When a Live agent fails, the orchestrator correctly moves the task to `blocked` and records
`agentState = failed`. A human can then use the task status control to move the task to `done`
after independently completing or verifying the work. The current status-only update preserves the
stale failed agent state, so the UI can show a completed task with a contradictory `Run failed`
indicator. Human context records the decision but does not itself change workflow status or agent
state.

## Goals

1. Make a human transition to `Done` clear stale `running`, `waiting`, or `failed` agent state.
2. Preserve failed run rows, error messages, run events, and prior activity as audit history.
3. Record a distinct human completion activity entry and useful task summary.
4. Keep agent-driven transitions unchanged, including automatic `blocked` on execution failure.
5. Keep the behavior consistent for Demo and Live task updates.

## Non-goals

- Do not delete or rewrite failed run history.
- Do not infer completion from a human context message alone.
- Do not automatically create a commit, PR, or GitHub status change.
- Do not change the meaning of `activeAgents` or current-process Cline liveness.
- Do not add a new workflow status.

## Requirements and acceptance criteria

- `PATCH /api/tasks/:taskId` with `status: "done"` applies the human completion transition.
- A task marked Done has `agent_state = idle` regardless of its previous `running`, `waiting`, or
  `failed` state.
- The task summary explains that a human marked it complete and does not erase the prior failure
  detail from its run record.
- One completion activity entry is added with a human/completion type and clear detail.
- Repeating the same Done update does not create unbounded duplicate completion activity.
- A status update to `blocked`, `ready`, or another non-Done state does not trigger completion
  cleanup.
- Existing human context behavior remains unchanged: local persistence in Demo mode and GitHub
  issue publication before local persistence in Live mode.

## Existing architecture

- `src/app/api/tasks/[taskId]/route.ts` accepts status and human context PATCH requests.
- `src/lib/server/repository.ts` owns task mapping, status persistence, summaries, and activity.
- `src/lib/server/repository.ts` now exposes an explicit `completeTaskByHuman` transition boundary.
- `src/components/ControlPlane.tsx` renders task status, agent state, human context, and activity.
- `src/lib/server/orchestrator.ts` sets blocked/failed state when agent execution fails.
- `tests/done-task-transition.test.ts` provides isolated temporary SQLite regression coverage.

## Proposed design

Add a repository-level transition helper or guarded branch in `updateTask` for a human Done
transition. The transition should:

1. Load the current task.
2. Detect `input.status === "done"`.
3. Set `agentState` to `idle` and summary to a human-completion message unless the caller supplies
   a more specific completion summary.
4. Persist the task status/state/summary update.
5. Add a completion activity only if no equivalent completion activity already exists for the task.

The API remains responsible for distinguishing status updates from human context updates. Agent
orchestrator calls that update status as part of execution should not accidentally create a human
completion event; the helper should receive an explicit transition source or the route should call
a dedicated `completeTaskByHuman` repository function.

## Data and state transitions

```text
blocked + failed
      -- human PATCH status=done --> done + idle
                                      |
                                      +--> human completion activity
                                      +--> failed run/error/events preserved
```

For a non-Done update:

```text
any task state -- ordinary status PATCH --> requested status + existing agent state
```

For repeated completion:

```text
done + idle -- human PATCH status=done --> done + idle (no duplicate completion activity)
```

## Affected files and boundaries

- `LLD/10-clear-stale-agent-state-on-human-done.md`: durable design and validation record.
- `src/app/api/tasks/[taskId]/route.ts`: identify human status transition source if needed.
- `src/lib/server/repository.ts`: implement atomic Done transition and idempotent completion activity.
- `tests/done-task-transition.test.ts` or the existing isolated repository test file: regression cases.
- `src/components/ControlPlane.tsx`: only if the completion summary/activity presentation needs a label adjustment.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Human completion hides useful failure context | Preserve run/error/event history and include a concise reference in activity. |
| Repeated polling/PATCH creates duplicate activities | Guard on an existing task completion activity or use an idempotent transition helper. |
| Agent code accidentally emits a human completion event | Keep the human source explicit at the API/repository boundary. |
| A task is already Done but agent state is stale | Allow one cleanup transition without duplicating activity. |
| Live GitHub context publication fails | Keep existing behavior: return the GitHub error and do not persist the context; status-only Done remains local. |

Rollback is limited to reverting the repository and test changes. Existing task/run/activity rows
remain valid because the transition is additive and does not delete history.

## Validation plan

1. Add a failed/blocked task fixture in an isolated temporary SQLite database.
2. PATCH or call the human completion boundary and verify status `done`, agent state `idle`, and
   completion summary/activity.
3. Verify failed run/error/event history remains present.
4. Repeat the Done transition and verify no duplicate completion activity is added.
5. Verify non-Done status updates preserve agent state.
6. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` separately.

## Decision log

- 2026-08-19: Created from task `task-d86af9b1-d0bc-45af-b0d6-2858b37dc898` after confirming human context records intent but does not itself change status.
- 2026-08-19: The fix must preserve failed run history; only the current task projection is normalized to Done/idle.
- 2026-08-19: Implemented an explicit API/repository human completion boundary so agent-driven updates cannot create human completion activity accidentally.

## Validation results

- `npm test`: passed; 8 tests passed, 0 failed, including the two Done-transition regressions.
- `npm run typecheck`: completed without TypeScript diagnostics; no active `tsc` process remained in follow-up inspection.
- `npm run build`: passed; Next.js compiled, completed TypeScript, generated 5 static pages, and finalized route optimization.
- `git diff --check`: passed before commit.
- The existing non-fatal Turbopack NFT tracing warning through `next.config.mjs` and `src/lib/server/db.ts` remains documented and outside this task’s scope.
- The requested task was created and verified as `task-d86af9b1-d0bc-45af-b0d6-2858b37dc898`, P1, Ready, under the canonical project.
- Implementation commit: `af74163bfed25c4b519f2962c9b74e0080512cb4` (`fix: normalize human task completion state`).

## Open questions and assumptions

- Assumption: “human marks Done” means a PATCH status transition from the task UI/API, not an agent
  orchestrator update.
- Assumption: an idempotent completion activity is preferable to recording every repeated UI PATCH.
- Open question: none blocking implementation.

## Completion checklist

- [x] Design reviewed
- [x] Human Done transition implemented
- [x] Stale agent state cleared
- [x] Completion activity added idempotently
- [x] Failure history preserved
- [x] Regression tests added
- [x] Tests, typecheck, build, and diff checks passed
- [x] LLD updated with final commit and verification results