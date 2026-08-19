# LLD: Enforce Feature-Branch Freshness Before PR Creation

## Status

- **Status:** Implemented; pending review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-20
- **Related task or issue:** Require every feature branch to be up to date with `main` before a PR is created or updated.

## Problem

The repository enforces PR-first development and template validation, but `scripts/create-pr.mjs`
currently allows a stale or diverged head branch to create a PR. GitHub’s branch-protection setting
can block the merge later, but agents should detect and repair freshness before spending a review
cycle on a stale branch.

## Goals

1. Refuse PR creation/update when the feature head is behind or diverged from `main`.
2. Provide a read-only verifier that reports ahead/behind status without remote writes.
3. Provide explicit `update` (merge `origin/main`) and `rebase` repair strategies.
4. Make the freshness requirement visible in root agent/workflow/PR documentation.
5. Preserve safe-runner, credential, branch, and force-push protections.

## Non-goals

- Do not automatically merge or rebase a branch during PR creation.
- Do not force-push after a rebase automatically.
- Do not operate on `main` with the update/rebase helper.
- Do not read `.env.local` or print credentials.
- Do not change GitHub rulesets through application code.

## Requirements and acceptance criteria

- `scripts/create-pr.mjs` queries `main...head` before any create/update and refuses when
  `behind_by > 0` or comparison status is `diverged`.
- `scripts/verify-branch-freshness.mjs` reports base/head/status/ahead/behind and exits non-zero
  for stale or diverged branches.
- `scripts/update-branch-from-main.mjs --strategy update|rebase` requires a clean non-main branch,
  fetches `origin/main`, performs the selected local repair, and never force-pushes.
- Agents are instructed to update/rebase, verify freshness, validate the PR template, then create/update the PR.
- Tests cover ahead, identical, behind, and diverged comparison states.
- Existing PR creation/template tests, typecheck, build, and diff checks remain green.

## Existing architecture and affected boundaries

- `scripts/create-pr.mjs` — PR remote-write boundary.
- `scripts/pr-template.mjs` — template validation boundary.
- `scripts/verify-branch-freshness.mjs` — remote read-only freshness boundary.
- `scripts/update-branch-from-main.mjs` — local branch repair boundary.
- `AGENTS.md` and `workflows/default/WORKFLOW.md` — agent contract.
- `.github/pull_request_template.md` and `LLD/pr-template-enforcement.md` — PR handoff contract.

## Proposed design

### Remote freshness invariant

Use GitHub’s compare endpoint for `main...head`. A branch may be ahead of `main`, but it must have
`behind_by = 0` and must not be `diverged` before a PR write.

```text
compare main...feature
  -> ahead/identical, behind=0 -> validate template -> PR write
  -> behind/diverged -> refuse -> update or rebase -> verify -> retry
```

### Repair strategies

- `update`: fetch `origin/main`, merge it into the feature branch, preserving remote history.
- `rebase`: fetch `origin/main`, rebase the feature branch, and leave any required force-with-lease
  push to an explicit, separately reviewed command.

Both strategies require a clean worktree and reject `main` as the current branch.

## Risks and recovery

| Risk | Mitigation |
| --- | --- |
| Compare API unavailable | Fail closed before PR write and report the remote error. |
| Branch has merge conflicts | Leave the conflict state visible; do not auto-abort or force-push. |
| Rebase rewrites a pushed branch | Never force-push automatically; require explicit `--force-with-lease`. |
| Stacked PR target differs from main | Freshness is always checked against `main`, while the PR base remains explicit. |
| Main changes after the check | Keep GitHub “Require branches to be up to date” enabled as the merge-time gate. |

Rollback reverts the helper/docs/tests. A local merge/rebase is recovered through normal Git conflict
resolution or `git rebase --abort` only after inspecting state.

## Validation plan

1. Unit-test comparison-state enforcement.
2. Run freshness verifier against the current remote branch.
3. Run tests, typecheck, build, and diff check through `safe-run`.
4. Create a template-compliant PR for this feature and verify its base/head/state.

## Decision log

- 2026-08-20: Freshness is checked against `main` regardless of an explicit stacked PR base.
- 2026-08-20: PR creation fails closed; repair is an explicit update or rebase action.
- 2026-08-20: GitHub branch protection remains the final merge-time freshness gate.

## Completion checklist

- [x] Design reviewed
- [x] Freshness verifier and create-pr gate implemented
- [x] Update/rebase helper implemented
- [x] Agent/workflow docs updated
- [x] Tests, typecheck, build, and diff checks passed
- [x] Template-compliant PR opened and verified
- [x] Human merge approval remains pending

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 20 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed with the existing non-fatal
  Turbopack NFT tracing warning through `next.config.mjs` and `src/lib/server/db.ts`.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- `npm run safe:run -- --timeout-ms 30000 -- node scripts/verify-branch-freshness.mjs --base main --head fix/branch-freshness-enforcement-main` — passed with `status=ahead`, `ahead=2`, `behind=0`.
- PR #15 — verified open at `https://github.com/maxlee98/project-agent-control-plane/pull/15`,
  base `main`, head `fix/branch-freshness-enforcement-main`, with the complete PR template body.