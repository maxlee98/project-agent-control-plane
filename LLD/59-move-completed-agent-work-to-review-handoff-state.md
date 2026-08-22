# LLD: Move Completed Agent Work to the Review Handoff State

## Status
- Status: Complete; pending human review
- Owner: Project Agent Control Plane
- Date: 2026-08-24
- Related task or issue: GitHub Issue #59

## Problem
Completed agent runs currently use the local `agent_review` status even though no automated PR
review has occurred. The dashboard therefore exposes a misleading state and GitHub Projects `Review`
options are not consistently projected to the local workflow.

## Goals
- Make `human_review` the only canonical post-agent handoff state and display it as `Review`.
- Transition successful Demo and Live runs only after their existing completion/PR checkpoints.
- Map the exact GitHub Projects `Review` option to `human_review`.
- Keep legacy `agent_review` and `in_review` values readable and normalize them without losing task
  metadata such as branch or PR URLs.
- Keep Review actions explicitly human/PR-oriented and preserve failure and stop behavior.

## Non-goals
- No automated PR reviewer.
- No change to Done semantics, issue closure, branch/workspace behavior, or PR creation behavior.
- No destructive migration or remote status rewrite that is not required for synchronization.

## Requirements and acceptance criteria
- Active runs remain `in_progress`; successful Demo and Live runs end in `human_review`.
- Live status is updated only after validation, branch publication, and PR creation/update succeed.
- Failed, stopped, or validation-failing runs do not enter Review.
- Inbound Project `Review` maps to local `human_review`.
- Persisted legacy `agent_review` rows are projected as `human_review`; legacy GitHub aliases remain
  accepted for compatibility.
- The dashboard says `Review`, not `Agent review` or an automated-review claim.
- Focused regression coverage protects Demo handoff, Live handoff, inbound mapping, and legacy data.

## Existing architecture
- `src/lib/domain.ts` defines board columns and `TaskStatus`.
- `src/lib/server/orchestrator.ts` owns Demo timers and Live validation/git/PR handoff.
- `src/lib/server/github.ts` normalizes Project status options and syncs Project items.
- `src/lib/server/repository.ts` maps and persists SQLite task rows.
- `src/components/ControlPlane.tsx` renders status controls, task actions, and handoff copy.
- Existing tests isolate the SQLite database and mock Live dependencies.

## Proposed design
Remove `agent_review` from the canonical board vocabulary while retaining a read-time compatibility
normalizer. Normalize `agent_review` to `human_review` in repository task mapping and in GitHub inbound
status mapping. Keep legacy aliases in the outbound status option lookup so existing Projects can be
reconciled safely, preferring the exact `Review` option. Update both orchestrator completion paths to
set `human_review`, and update UI options/copy and workflow documentation to use `Review`.

## Data and state transitions
```text
Ready -> In Progress -> Review -> Done
             |             ^
             +-> Blocked  successful validation + (Live) push/PR
             +-> stopped/waiting
```

Demo reaches Review at its existing 100% simulated completion step. Live reaches Review only after
`commitAndPush` and `createPullRequest` return successfully and the stop guard passes. Optional issue
comment failure keeps the completed run in Review and records its warning, matching existing behavior.

## Affected files and boundaries
- `LLD/59-move-completed-agent-work-to-review-handoff-state.md`
- `src/lib/domain.ts`
- `src/lib/server/orchestrator.ts`
- `src/lib/server/github.ts`
- `src/lib/server/repository.ts`
- `src/components/ControlPlane.tsx`
- `src/app/api/tasks/[taskId]/route.ts`
- `workflows/default/WORKFLOW.md`, `README.md`, and relevant architecture documentation
- Focused lifecycle/status synchronization tests

## Risks, edge cases, and rollback
The primary risk is treating a legacy Project option or database value as unknown and losing its
task association. Read-time normalization is additive and preserves branch/PR fields. Outbound
status lookup accepts legacy aliases, and unknown options continue to fail explicitly. Rollback is a
focused code revert; no destructive database or GitHub operation is needed.

## Validation plan
1. Run focused status/domain, Demo lifecycle, Live lifecycle, and GitHub synchronization tests.
2. Run the complete test suite and typecheck.
3. Run the production build with an isolated data directory if required by the environment.
4. Inspect diff/whitespace and verify no automated PR-review API or unintended remote write exists.

## Decision log
- 2026-08-24: Verified canonical GitHub Issue #59 and current feature branch before editing.
- 2026-08-24: Keep `human_review` as the stable internal status and normalize legacy values at read
  boundaries instead of performing a destructive migration.
- 2026-08-24: Prefer exact Project option `Review` while retaining legacy aliases for compatibility.
- 2026-08-24: Removed `In Progress` from the human-review outbound aliases so a missing `Review` option
  cannot silently misclassify an active task as ready for human review.
- 2026-08-24: Make the Review task's primary UI action open its PR; retain implementation continuation
  as a separately labeled secondary action so the handoff is unambiguously human-owned.
- 2026-08-24: Renamed the existing Issue #20 and Issue #54 LLDs to issue-first filenames while
  retaining the no-canonical-issue API-validation document as an explicit historical exception.

## Open questions and assumptions
- Assumption: the existing `human_review` status is the compatibility target for legacy persisted and
  remote values.
- Future automated review, if added, should have a distinct status/result rather than reusing this
  human handoff state.
- Review-task continuation remains available but must not be described as automated PR review.

## Validation results
- `npm install` — passed; installed dependencies. npm reported 20 audit findings and Node 23 engine
  warnings for transitive packages.
- `npm run typecheck` — passed.
- `npm test` — 88 tests passed, 0 failures after the current `main` merge and status/UI regression fixes. The test suite still emits
  existing Node experimental/module-type warnings.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- `npm run build` — the initial build failed during parallel page-data collection with a transient
  SQLite lock in the shared environment; a repeat using an isolated `DATA_DIR` and single build worker
  passed compilation, typecheck, static generation, and route output. The successful build reports the
  existing NFT tracing warning.
- No automated PR-review API or unrelated remote write was added; Live handoff uses the existing
  status reconciliation boundary after PR creation.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed; the isolated production build reports only the existing
  NFT tracing warning
- [x] Documentation updated
- [x] Handoff verified (PR #60 is open; human review and merge remain pending)

## Handoff
- Branch: `agent/59-Task-Move-completed-agent-work-to--a81a662b`, pushed and verified fresh against
  `main` with `ahead=4`, `behind=0`.
- Commits: `264d3a4` (implementation follow-up) and `0541649` (validation record), on top of the
  existing task implementation and current `main` merge.
- Pull request: [#60](https://github.com/maxlee98/project-agent-control-plane/pull/60), verified open
  with base `main`, head `agent/59-Task-Move-completed-agent-work-to--a81a662b`, validated template,
  and `Fixes #59`. The latest remote workflow run was queued/pending at final verification after the
  branch update; no merge was performed.