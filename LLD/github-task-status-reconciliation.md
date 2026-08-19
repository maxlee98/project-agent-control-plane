# LLD: GitHub Task Status Reconciliation

## Status

- **Status:** Implemented; pending review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-20
- **Related task:** Task #10, `task-d86af9b1-d0bc-45af-b0d6-2858b37dc898`
- **Related project:** `maxlee98/project-agent-control-plane`

## Problem

Moving Task #10 to Done in the control-plane kanban changes the local SQLite task projection, but
the linked GitHub issue remains open. The current Sync action only reads GitHub Projects V2 items
into SQLite; it does not update issue open/closed state, update a Project item, inspect issue state,
or surface a failed response to the UI. The current live project record also has no stored
`github_project_id`, so a Projects V2 sync cannot be performed and must not be reported as
successful.

## Goals

1. Keep local task status, GitHub Projects V2 status, and GitHub issue lifecycle consistent in Live mode.
2. Make `Done` close the linked issue and non-Done workflow states keep the issue open.
3. Make Sync repair issue lifecycle mismatches based on the GitHub Projects V2 status.
4. Update matching Projects V2 status options from human local status changes.
5. Surface missing configuration, unmapped options, permission errors, and partial remote failures.
6. Keep Demo mode local-only and preserve the existing local agent/run state model.

## Source-of-truth contract

- GitHub Projects V2 status is the workflow source of truth.
- GitHub Issue open/closed state is a derived lifecycle mirror:
  - Project status `Done` => issue `closed`.
  - Any other supported project status => issue `open`.
- SQLite is the local projection and execution-state store.
- A local human status change in Live mode must complete its remote reconciliation before SQLite is
  updated. If the remote operation fails, the local task remains unchanged and the UI shows the error.
- Sync reads the GitHub project status, repairs the issue lifecycle, then upserts the local projection.

## Non-goals

- Do not alter issue labels, assignees, comments, milestones, or PR state as part of status sync.
- Do not infer a Projects V2 status from issue state alone.
- Do not silently map unknown/custom project options to a different workflow state.
- Do not make GitHub API requests in Demo mode.
- Do not claim a successful sync when the project ID or a remote reconciliation is missing/failed.

## Requirements and acceptance criteria

- A Live human transition to `Done` updates the matching Project item to a `Done` option and closes
  the linked issue before local persistence.
- A Live human transition from `Done` to a supported non-Done status updates the Project item and
  reopens the linked issue before local persistence.
- Sync reads project item status and issue state, repairs an open issue whose project item is Done,
  and persists the project status locally.
- Sync returns a non-2xx response when the project lacks a `github_project_id`, the issue is not
  present in the project, no compatible status option exists, or GitHub rejects a mutation.
- The UI displays the returned error for failed status changes and Sync instead of success text.
- A project status option that cannot be mapped to the local workflow is reported explicitly and is
  not silently overwritten.
- Demo status changes and Demo Sync do not call GitHub.
- Existing failed-run history and local agent state are preserved, except a task synchronized as
  Done is normalized to idle to avoid contradictory current-task presentation.

## Existing architecture

- `src/lib/server/github.ts` owns REST/GraphQL normalization and remote mutations.
- `src/app/api/projects/[projectId]/sync/route.ts` owns Sync request orchestration.
- `src/app/api/tasks/[taskId]/route.ts` owns human task status PATCH behavior.
- `src/lib/server/repository.ts` owns the SQLite task projection.
- `src/components/ControlPlane.tsx` owns status and Sync feedback.
- `docs/architecture.md` defines GitHub as the source of truth for issues and Projects V2 status.

## Proposed design

### GitHub adapter

Extend the Projects V2 query boundary to retain only normalized reconciliation metadata:

- project item ID;
- Status field ID;
- selected option ID/name;
- available status option IDs/names;
- issue number, URL, and open/closed state.

Add REST issue state updates and the `updateProjectV2ItemFieldValue` GraphQL mutation. Status
aliases are deliberately narrow and human-readable: `Todo`/`Inbox`, `Ready`, `In Progress`,
`Agent Review`/`In Review`, `Human Review`, `Blocked`, and `Done`/`Complete`. If an alias is absent,
return an actionable unmapped-option error.

### Human status PATCH

In Live mode, the route loads the task/project and calls an adapter reconciliation helper before
calling `completeTaskByHuman` or generic `updateTask`. The helper updates the Project item and then
the issue lifecycle. GitHub operations are not transactional; a later Sync repairs a partial
remote result and the API returns the failure rather than persisting a false local state.

### Project Sync

Sync loads all project items, reconciles each issue lifecycle against the Project status, and only
then upserts the local task projections. It returns the count of imported items and remote repairs.
The current project record without a `github_project_id` fails clearly with the existing setup
guidance, so the user must register the actual `PVT_…` ID before Projects V2 Sync can work.

### UI feedback

Status changes and Sync inspect `response.ok`, read the returned error, and show an error toast.
Success messages include the remote reconciliation result rather than claiming success for a
failed request.

## Data and state transitions

```text
local human Done
  -> update Project item to Done
  -> close GitHub issue
  -> persist SQLite task as done/idle
```

```text
Sync
  -> read Project item status + issue state
  -> repair issue open/closed lifecycle
  -> upsert SQLite task projection
```

If a remote step fails:

```text
remote error -> return 502 -> do not persist local human transition
              -> next Sync retries reconciliation
```

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Project ID missing | Return a clear setup error; never claim Sync succeeded. |
| Project item missing for a linked issue | Return an actionable reconciliation error. |
| Custom status option has no local mapping | Report it; do not silently select another option. |
| Issue update succeeds but Project update fails (or vice versa) | Return the remote error and let the next Sync repair the derived issue lifecycle. |
| User manually closes an issue while the project status is not Done | Sync reopens it because Project status is the workflow source of truth. |
| A synchronized Done task has a failed agent state | Normalize the current task projection to idle while preserving run history. |
| GitHub API rate limit/permission failure | Propagate a redacted 502 error and leave local human status unchanged. |

Rollback is reverting the adapter, route, repository, UI, test, and LLD changes. No schema migration
is required.

## Validation plan

1. Unit-test Projects V2 metadata parsing and status aliases.
2. Mock GitHub REST/GraphQL requests to verify Done close, reopen, Project option mutation, and
   unmapped-option failures.
3. Test Sync repair and missing-project-ID errors.
4. Test local human status persistence is blocked on a remote failure.
5. Verify Demo mode makes no remote request.
6. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` separately.
7. Update this LLD with exact results and the PR URL.

## Decision log

- 2026-08-20: Confirmed Task #10 is locally Done while its linked issue remains open.
- 2026-08-20: Confirmed the live project record has no `github_project_id`; Sync must report this rather than claim success.
- 2026-08-20: Selected Projects V2 status as workflow source of truth and issue open/closed as a derived lifecycle mirror.

## Completion checklist

- [x] LLD reviewed
- [x] GitHub adapter mutations implemented
- [x] Human status route reconciles remote state
- [x] Sync repairs remote lifecycle and reports failures
- [x] UI handles failed responses
- [x] Regression tests added
- [x] Tests, typecheck, build, and diff checks passed
- [ ] Dedicated branch pushed and PR opened
- [ ] Human merge approval remains pending

## Validation results

- `npm test` — passed, 11 tests.
- `npm run typecheck` — passed.
- `npm run build` — passed. Next reported one existing non-fatal Turbopack NFT tracing warning
  caused by dynamic filesystem access in `src/lib/server/db.ts`.
- `git diff --check` — passed.