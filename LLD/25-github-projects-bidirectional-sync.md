# LLD: Reliable GitHub Projects V2 and Dashboard Synchronization

## Status

- **Status:** Implemented; pending human review and merge
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-20
- **Related task or issue:** [Issue #25](https://github.com/maxlee98/project-agent-control-plane/issues/25) — Repair Projects V2 sync and keep dashboard tasks, repository Issues, and Project items aligned.

## Problem and observed evidence

The repository was configured with the valid Projects V2 node ID
`PVT_kwHOA1cLdc4Bg2Pz` for Project Agent Harness (#3), which has a usable Status field and items
from `maxlee98/project-agent-control-plane`. Sync still returned HTTP 502 because the one-line
GraphQL document in `src/lib/server/github.ts` had 20 opening braces and only 19 closing braces:

```text
GitHub GraphQL: Expected NAME, actual: (none) ("") at [1, 471]
```

The dashboard task creation path creates a GitHub Issue but does not add that Issue to Projects V2.
The reverse path can import Issue project items, but must be idempotent, repository-scoped, and
preserve local execution history.

The live database initially contained local task references that no longer represented Issues in the
configured repository. Project #3 contained Issues #10, #14, and #17, while local tasks also
referenced Issue #2 plus stale references #7, #9, #12, and #15. GitHub #9 was a Pull Request and
#15 was not an Issue, so those numbers must not be reused as task identities. The approved live
backfill later resolved 13 Project Issues into 13 local tasks, correcting or creating identities as
needed and importing five Project-only Issues.

## Goals

1. Make Projects V2 reads syntactically valid and diagnose invalid/inaccessible project configuration.
2. Import repository Issue project items into the local dashboard idempotently.
3. Make dashboard-created Live tasks create an Issue and add it to the configured Project.
4. Synchronize Project Status and Issue open/closed lifecycle in both directions.
5. Report partial remote success honestly when an Issue exists but Project insertion/status fails.
6. Preserve Demo mode as local-only and preserve local task run/branch/PR history.
7. Resolve every live local task to a real repository Issue and Project item, correcting stale
   numbers or creating a new Issue from the local task context when no matching Issue exists.

## Non-goals

- Do not import Project Pull Requests as dashboard Tasks.
- Do not delete remote Issues, Project items, or local tasks during sync.
- Do not invent custom Project Status options or silently treat unmapped options as successful.
- Do not expose GitHub tokens or raw authenticated response bodies.
- Do not repurpose Pull Requests or unrelated Issues to repair a stale local task reference.

## Existing architecture and affected boundaries

- `src/lib/server/github.ts` — GitHub REST/GraphQL adapter and status lifecycle reconciliation.
- `src/app/api/projects/[projectId]/sync/route.ts` — explicit Project-to-dashboard sync endpoint.
- `src/app/api/tasks/route.ts` — dashboard-to-Issue task creation endpoint.
- `src/app/api/tasks/[taskId]/route.ts` — dashboard status/comment synchronization.
- `src/lib/server/repository.ts` — SQLite project/task persistence and upsert behavior.
- `src/components/ControlPlane.tsx` — user-visible sync error and partial-success messages.

## Design

### Project snapshot query

Use a readable GraphQL query with variables and pagination. Query the Project node, Status field
configuration, item IDs, Issue content node IDs, repository identity, labels, and field values. Fail
closed with an actionable error when the node is null, not a `ProjectV2`, or has no usable Status field.

### GitHub → dashboard

```text
Project items -> filter Issue + registered repository -> map Todo/In Progress/Done
              -> reconcile Issue lifecycle -> upsert by project + issue number
```

Project Pull Requests and items for other repositories are skipped. Existing local task execution
state is preserved while remote title, description, labels, URL, and workflow status are refreshed.

### Dashboard → GitHub

```text
dashboard task -> create Issue -> add Issue node to Project if absent
               -> set Project Status -> persist local issue number/url
```
The add operation is duplicate-safe by checking current Project content before calling
`addProjectV2ItemById`. GitHub Project connections are eventually consistent after this mutation,
so readback retries are bounded before reporting a partial failure. If Issue creation succeeds but a
later Project operation fails, persist the local Issue link and return a warning/partial status rather
than pretending both systems are consistent.

### Existing local task backfill

During a Live Project sync, each non-Demo local task is resolved before the Project snapshot is
upserted. A valid Issue number is verified through the repository Issue API. A missing number,
Pull Request reference, or 404 is matched by normalized title against existing Issues; if no exact
Issue exists, a new Issue is created from the local title and description. The returned Issue
number, URL, and Project item are then persisted idempotently. Newly added Project items receive
the local task status once; existing Project items remain governed by the Project status source of
truth.

### Status mapping

The configured Project exposes `Todo`, `In Progress`, `Review`, and `Done`. Local `inbox`/`ready` map to
Todo; `in_progress` and `blocked` map to In Progress; `human_review` maps to Review; `done` maps to Done.
Inbound Project statuses map to `ready`, `in_progress`, `human_review`, and `done`; legacy review names
remain accepted as aliases. Unsupported custom options fail with an explicit diagnostic.

## Data and state transitions

```text
Dashboard create -> GitHub Issue -> Project item -> Project status -> SQLite task
Project item sync -> repository Issue lifecycle -> SQLite task upsert
Dashboard status -> Project status + Issue state -> SQLite task status
Live task backfill -> verified/created Issue -> Project item -> corrected SQLite Issue identity
```

Sync is repeatable: the same Project item maps to one local task by project + Issue number, and the
same Issue maps to one Project item by Issue node ID/number.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Invalid or inaccessible `PVT_…` ID | Detect null/non-ProjectV2 node and return actionable diagnostics. |
| GraphQL query or schema failure | Keep query readable, test mocked responses, and return sanitized GraphQL messages. |
| Project has no Status field | Fail the sync/status operation explicitly; do not silently write local-only state in a full sync. |
| Issue created but Project insertion fails | Persist Issue link and return partial-success warning for retry. |
| Issue already exists as a Project item | Reuse the existing item; never add a duplicate. |
| Project contains other repositories or PRs | Filter by exact repository and Issue content type. |
| Done/reopen transition | Close Issue for Done and reopen it for every non-Done local status. |
| Demo mode | Do not call GitHub; retain current local simulation behavior. |
| Stale local Issue number | Verify the number, reject Pull Requests, match by title, or create a new Issue; persist the returned number and URL. |
| Existing task is not a Project item | Add it once and initialize its Project status from the local status. |

Rollback reverts adapter, route, repository, tests, docs, and LLD changes. Existing remote Issues and
Project items are not deleted by this feature.

## Validation plan

1. Add mocked GraphQL/REST tests for query results, filtering, status mapping, item insertion, retry,
   partial failure, lifecycle transitions, stale-number repair, and Issue creation.
2. Reproduce the authenticated local sync with Project #3 after the fix.
3. Run tests, typecheck, build, and diff checks through `safe-run`.
4. Create a complete template-compliant PR and verify its remote state.

## Decision log

- 2026-08-20: Project #3 was verified as Projects V2 with ID `PVT_kwHOA1cLdc4Bg2Pz`.
- 2026-08-20: The 502 was traced to an unterminated GraphQL selection document, not credentials.
- 2026-08-20: Repository Issues are the dashboard task boundary; Project Pull Requests remain excluded.
- 2026-08-21: Live sync will backfill every local Issue-backed task into Project #3; stale or Pull Request references are repaired by exact-title matching or new Issue creation, never by reusing an unrelated number.
- 2026-08-21: GitHub accepted Project-item mutations before the connection query exposed them; bounded readback retries were added and the live backfill completed with 13 local/remote Issue mappings.

## Completion checklist

- [x] Design reviewed
- [x] GraphQL query and diagnostics implemented
- [x] Bidirectional Issue/Project item sync implemented
- [x] Tests, typecheck, build, and diff checks passed
- [x] Authenticated sync verified against Project #3
- [x] Existing live task Issue identities and Project membership reconciled
- [ ] Template-compliant PR opened and verified
- [ ] Human merge approval remains pending