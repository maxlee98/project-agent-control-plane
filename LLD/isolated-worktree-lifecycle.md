# LLD: Add Isolated Worktree Lifecycle

## Status
- Status: Complete; pending pull request human review
- Owner: Project Agent Control Plane
- Date: 2026-08-22
- Related task or issue: GitHub Issue #26 — Add isolated worktree lifecycle

## Problem and observed evidence

Live execution needs a deterministic, isolated Git workspace for each task run. The existing
workspace adapter creates a path under `WORKSPACE_ROOT`, but its lifecycle contract is not covered by
direct tests: fresh runs must never silently reuse an old path, continuation must reuse only a
registered worktree, and failures must retain the recorded workspace for inspection. A failed live
run currently relies on the orchestrator not calling cleanup; that preservation behavior needs an
explicit, reviewable contract.

## Goals

1. Create one deterministic, run-scoped Git worktree and branch for every fresh task run.
2. Keep `continue` as the only mode allowed to reuse a recorded workspace, after verifying that Git
   still registers it and that it belongs to the configured repository.
3. Make fresh-run collisions fail closed instead of reusing or deleting an existing workspace.
4. Preserve a successfully-created workspace when a later live stage fails, with the path retained in
   the run record for inspection and recovery.
5. Add network-free tests for naming, fresh/reuse behavior, collision handling, and failure
   preservation through injected live-run dependencies.

## Non-goals

- Do not redesign the Cline session lifecycle or GitHub handoff.
- Do not automatically remove failed worktrees or add a cleanup scheduler.
- Do not reuse a failed workspace for `retry`; only explicit `continue` can reuse one.
- Do not add database tables or expose repository credentials/raw command output.
- Do not perform a real provider/GitHub run as part of automated validation.

## Requirements and acceptance criteria

- The workspace path is derived only from the configured workspace root, repository identity, task ID,
  and run ID after safe normalization; a fresh run has a unique branch name derived from task/run
  identity.
- `start` and `retry` reject an existing registered or filesystem workspace path rather than reusing
  it.
- `continue` requires the supplied recorded path to be a registered worktree of the configured
  repository and returns its current branch; unavailable or foreign paths fail closed.
- A failed live stage does not invoke workspace removal, and the run retains the created workspace
  path so an operator can inspect it or explicitly continue it.
- Workspace lifecycle events distinguish fresh creation from explicit continuation reuse.
- Focused workspace/orchestrator tests, the full test suite, typecheck, build, and whitespace checks
  pass.

## Existing architecture and affected boundaries

- `src/lib/server/workspaces.ts` owns checkout validation, deterministic worktree/branch creation,
  continuation verification, changed-file collection, checks, and Git handoff.
- `src/lib/server/orchestrator.ts` sequences the live stages and persists the workspace path before
  Cline/validation/Git failures can occur.
- `src/lib/server/repository.ts` persists `workspace_path`, branch, run status, and lifecycle events.
- `tests/live-run.test.ts` already provides injected live dependencies and failure fixtures.
- `docs/architecture.md` and the live-ops skill document operator expectations for preserved failed
  workspaces.

## Proposed design

Keep the existing `WorkspaceHandle` boundary and make its invariants explicit:

```text
fresh start/retry
  -> validate configured checkout
  -> derive <root>/<safe-repository>/<safe-task>/<safe-run>
  -> reject registered/path collision
  -> git worktree add -b <deterministic branch> <path> origin/<default>
  -> persist path + branch + workspace_created

explicit continue
  -> validate configured checkout
  -> verify recorded absolute path is an exact registered worktree
  -> read current branch
  -> persist path + branch + workspace_reused

any later live failure
  -> persist failed/blocked state with workspace path unchanged
  -> do not call removeWorkspace
```

The existing `removeWorkspace` helper remains an explicit future/operator cleanup seam but is not part
of automatic failure handling. Path checks use exact parsed worktree entries rather than substring
matching, avoiding accidental acceptance of a similarly-prefixed path.

## Data and state transitions

```text
queued -> workspace preparation
       -> workspace_created (fresh) or workspace_reused (continue)
       -> Cline/validation/Git/PR
       -> failed + blocked + recorded workspace preserved

retry: queued -> fresh workspace preparation (never source workspace reuse)
continue: queued -> recorded registered workspace reuse (only explicit reuse path)
```

No schema migration is required; `runs.workspace_path` and existing run event types are sufficient.

## Affected files and boundaries

- `LLD/isolated-worktree-lifecycle.md`: durable design and validation record.
- `src/lib/server/workspaces.ts`: exact worktree membership checks and deterministic lifecycle rules.
- `src/lib/server/orchestrator.ts`: preserve workspace evidence across failures, if a focused change is
  required by tests.
- `tests/workspaces.test.ts`: direct filesystem/Git lifecycle coverage.
- `tests/live-run.test.ts`: failure-path preservation regression, if additional coverage is needed.
- `docs/architecture.md`: clarify the lifecycle contract only if implementation behavior changes.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Two runs derive the same path | Run ID is part of the path; registered and filesystem collisions fail closed. |
| A path merely contains another worktree path | Parse exact porcelain worktree records instead of using substring matching. |
| Recorded workspace was manually removed | `continue` fails with an actionable unavailable-workspace error; retry creates fresh state. |
| A continuation path belongs to another repository | Require exact membership in the configured repository's worktree listing. |
| Worktree creation fails after parent directories are made | No cleanup of unrelated paths; the failed run is recorded and no workspace is claimed. |
| Cline/check/Git/PR fails after creation | Orchestrator leaves the handle and persisted path intact; no automatic removal. |
| Cleanup is needed later | Keep removal explicit and narrowly scoped; rollback does not delete preserved workspaces. |

Rollback is a revert of the workspace adapter/tests/docs changes. Any already-created worktree is
left for operator inspection and must not be removed by rollback automation.

## Validation plan

1. Read back the LLD and relevant workspace/orchestrator code before implementation.
2. Run focused workspace lifecycle tests through `safe:run`.
3. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` separately.
4. Inspect the final diff and verify no environment files, credentials, or unrelated modules changed.
5. Verify branch freshness, validate the required PR template, and hand off through the repository PR
   script only after a canonical Issue linkage is confirmed.

## Validation results

- `npm install`: completed successfully to restore the declared dependencies; npm reported 20 audit
  vulnerabilities and Node 23 engine warnings for transitive packages.
- Focused workspace suite: passed; 4 tests, 0 failures. This covers deterministic run-scoped paths and
  branches, registered/filesystem collision rejection, explicit continuation reuse, and exact path
  matching.
- `npm test`: passed; 62 tests, 0 failures.
- `npm run typecheck`: passed without TypeScript diagnostics.
- `env NODE_ENV=production npm run build`: passed; Next.js compiled and generated all 5 pages. The
  existing non-fatal Turbopack NFT tracing warning remains in the build output.
- `git diff --check`: passed.
- No real provider/GitHub run was executed; the network-free Git fixture and existing injected live-run
  failure test cover this change without credentials or remote side effects.

## Decision log

- 2026-08-22: Treat `start` and `retry` as fresh-workspace modes; only explicit `continue` may reuse
  a recorded workspace, matching the live-ops safety contract.
- 2026-08-22: Preserve failed workspaces by omission of automatic cleanup, while retaining the
  existing explicit removal seam for future verified operator cleanup.
- 2026-08-22: Use exact parsed Git worktree records instead of substring matching for continuation
  authorization and collision detection.

## Open questions and assumptions

- Assumption: `origin/<defaultBranch>` is the intended fresh-run base because the current live Git
  handoff already uses the configured remote default branch.
- Assumption: `runId` is generated uniquely by the repository layer and is stable for the run.
- Open question: a later cleanup command may need a persisted operator authorization/audit record;
  this task deliberately leaves cleanup explicit and out of automatic failure handling.

## Completion checklist
- [x] Intake and design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] Documentation updated
- [x] Handoff verified

## Handoff

- Commit: `815b08653e0c7ff8ebeb6dd9377463a2a408a2a2` (`worktree-lifecycle`)
- Branch: `agent/26-Add-isolated-worktree-lifecycle-4e6ab968`, verified on origin at the same commit.
- Freshness: verified against `main`; status `ahead`, `ahead=1`, `behind=0`.
- Pull request: [#43](https://github.com/maxlee98/project-agent-control-plane/pull/43), verified open,
  base `main`, head `agent/26-Add-isolated-worktree-lifecycle-4e6ab968`, and required template headings
  present. Human review and merge remain pending.