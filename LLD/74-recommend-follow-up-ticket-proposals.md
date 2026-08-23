# LLD: Recommend follow-up ticket proposals after resolved work

## Status
- Status: Complete; pending human review
- Owner: Project Agent Control Plane
- Date: 2026-08-24
- Related task or issue: GitHub Issue #74

## Problem
Completed and human-reviewed tasks contain useful context for adjacent work, but operators must
reconstruct that work manually. The control plane has task, activity, local creation, and GitHub
integration boundaries, but no review-gated proposal workflow.

## Goals
- Expose a Recommend follow-ups action for Done and Review tasks.
- Generate a small, bounded, redacted set of editable proposals from resolved task context.
- Allow an operator to add, edit, select, and explicitly confirm proposals.
- Create only selected proposals as local Inbox tasks in Demo mode or canonical GitHub Issues with
  Projects V2 synchronization in Live mode.
- Record recommendation and per-proposal creation outcomes in activity and make mutations idempotent.

## Non-goals
- Automatic ticket creation or agent execution for proposals.
- Changes to the source task, cross-repository proposals, or a second issue template.
- Duplicate detection beyond the existing task creation boundary in this first slice.

## Requirements and acceptance criteria
- Done and human_review task detail exposes an accessible action.
- Recommendation responses include title, rationale, priority, description, acceptance criteria, and
  generated/manual origin, with bounded fields and no raw agent output.
- The UI supports manual proposals, selection, editing, discard, and confirmation.
- Demo creation is local-only and visibly reports that no GitHub request was made.
- Live creation uses the existing issue creation and Project reconciliation boundaries and reports
  partial failures per proposal without claiming failed tickets succeeded.
- Recommendation and creation are validated, redacted, bounded, idempotent, and audited.

## Existing architecture and affected boundaries
- `src/components/ControlPlane.tsx` owns the client dashboard, task detail rail, and task actions.
- `src/lib/server/repository.ts` owns SQLite tasks, activities, idempotency, and dashboard projections.
- `src/app/api/tasks/route.ts` is the existing task creation contract and demonstrates Live Issue/
  Project synchronization.
- `src/lib/server/github.ts` owns canonical Issue body rendering, Issue creation, and Project status
  reconciliation.
- `src/lib/server/cline.ts` owns the host-side ClineCore session boundary and redacted event handling.
- Existing API helpers enforce bounded bodies, safe errors, and idempotency keys.

## Proposed design
Add a pure proposal contract/validation module and a recommendation service. `POST /api/tasks/:taskId/
follow-ups/recommend` validates a bounded request, gathers the source task plus recent activity and
run summary, asks the existing ClineCore adapter for a short JSON response when Live is configured,
and uses a safe deterministic proposal fallback in Demo mode. All parsed fields are normalized,
bounded, and redacted before returning. Recommendation itself is recorded as activity.

`POST /api/tasks/:taskId/follow-ups/create` accepts only normalized selected proposals and an
Idempotency-Key. It confirms the source task is Done or Review, creates each selected proposal through
the existing repository/GitHub boundary, and returns per-proposal statuses (`created`, `failed`, or
`replayed`) plus a Demo-mode no-network message. Each successful local task starts in Inbox. A single
request-level idempotency record prevents duplicate retries; remote Issue lookup/creation remains
inside the existing create-task/reconcile path and failures are never represented as successful.

The task detail action opens a review modal. Proposals are editable controlled fields with checkbox
selection; a manual blank proposal can be added. Confirmation is disabled unless at least one valid
proposal is selected and clearly states the execution mode.

## Data and state transitions
```text
Done/Review task
  -- recommend --> bounded proposal list + recommendation activity
  -- add/edit/select --> client-only review state
  -- confirm + idempotency key -->
      Demo: selected proposals -> local Inbox tasks -> creation activity
      Live: selected proposals -> Issue + Project sync -> local linked tasks
      partial error: per-proposal failures + warning activity; retry same key replays response
```

No schema migration is required; proposals are transient and activity/idempotency use existing tables.

## Affected files and modules
- `LLD/74-recommend-follow-up-ticket-proposals.md`: durable design and validation record.
- `src/lib/domain.ts`: normalized proposal types and origin/result contracts.
- `src/lib/server/follow-ups.ts`: bounded proposal parsing, recommendation prompt/fallback, and
  selected-proposal creation orchestration.
- `src/lib/server/api.ts`: follow-up limits and proposal field validation helpers.
- `src/lib/server/repository.ts`: source-task context/activity query and safe task creation activity.
- `src/app/api/tasks/[taskId]/follow-ups/recommend/route.ts`: recommendation endpoint.
- `src/app/api/tasks/[taskId]/follow-ups/create/route.ts`: confirmed creation endpoint.
- `src/components/ControlPlane.tsx`: task action, modal editing/selection, and feedback.
- `tests/follow-ups.test.ts`: validation, fallback, selection/creation, idempotency, and failures.

## Risks, edge cases, and rollback
- Low-quality or duplicate suggestions: human review, editable fields, explicit selection, and no
  automatic runs.
- Secrets or oversized model output: bounded prompt/response parsing and existing redaction before
  persistence or UI display.
- Partial Live failures: process proposals independently, persist only successful task links, and
  return safe per-proposal errors.
- Retry after a remote timeout: request-level idempotency prevents repeat calls when a response was
  persisted; unresolved external ambiguity remains a warning for human reconciliation.
- Rollback is code revert; already-created Issues remain human-owned and are not deleted.

## Validation plan
- Focused follow-up unit/API contract tests, including Demo network-free and Live adapter injection.
- Full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`, all through `safe:run`.
- Manual UI review of Done/Review action, generated/manual editing, subset confirmation, and mode
  feedback without exposing credentials.

## Decision log
- 2026-08-24: Use Issue #74 as the canonical identity and this issue-numbered LLD.
- 2026-08-24: Keep proposals transient rather than adding a proposal schema; selected creation is
  the only durable mutation besides activity/idempotency records.
- 2026-08-24: Use a lightweight ClineCore request only for configured Live recommendations; Demo is
  deterministic and network-free so its behavior remains truthful.
- 2026-08-24: Reuse the existing task creation semantics and Project reconciliation instead of a
  second GitHub integration path.

## Open questions and assumptions
- Assumption: the first version recommends only within the source task's registered repository.
- Assumption: existing `createIssue` canonical body rendering is sufficient for proposal Issues.
- Duplicate search across local tasks and GitHub Issues remains a follow-up; the editable review step
  is the first duplicate safeguard.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] Documentation updated
- [x] Handoff verified (PR #77 is open and targets `main`; branch and Issue linkage verified)

## Validation results
- `npm run safe:run -- --timeout-ms 120000 -- node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/follow-ups.test.ts tests/follow-ups-ui.test.ts` — passed, 7 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 107 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- env NODE_ENV=production DATA_DIR=/tmp/control-plane-build-follow-ups npm run build` — passed. Next reported the existing NFT tracing warning from dynamic workspace filesystem access.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- Dependency install was required in the recovered workspace; npm reported 20 audit findings (3 low, 13 moderate, 4 high) and existing Node engine warnings for transitive packages. No dependency manifest changes were made.
- Manual UI verification remains for a human reviewer: exercise the Done/Review action, edit and deselect generated proposals, add a manual proposal, confirm only a subset, and verify Demo/Live feedback with configured credentials.
- PR handoff: commit `5691483e5646e8bac113893c91ee3672bee2f9e1`, branch `agent/74-Task-Recommend-follow-up-ticket-pr-7e665392`, PR `#77` (`https://github.com/maxlee98/project-agent-control-plane/pull/77`) open against `main`.