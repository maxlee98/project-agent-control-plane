# LLD: Issue-Linked Pull Request Handoff

## Status

- **Status:** Complete; PR #29 open pending human review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-21
- **Related task or issue:** https://github.com/maxlee98/project-agent-control-plane/issues/28

## Problem and observed evidence

The repository correctly treats GitHub Issues and Projects V2 items as task state, and the Project
sync ignores Pull Request content. However, the LLD skill and PR workflow currently say to link a
control-plane task or LLD without requiring a canonical GitHub Issue. The application PR handoff
also falls back to a local task ID when `task.issueNumber` is absent. That permits a standalone PR
that cannot be represented by the Issue-only Project board.

## Goals

1. Require every implementation PR to reference one canonical GitHub Issue.
2. Keep the Projects V2 board Issue-only: one task has one Issue Project item; its PR is linked to
   that Issue and is not added as a second task card.
3. Use an explicit non-closing reference such as `Refs #123` so linkage does not unexpectedly close
   an Issue.
4. Enforce the policy in agent guidance, PR-template validation, and application-generated PRs.
5. Reject missing Issue identity before a live PR is created.

## Non-goals

- Do not add Pull Requests as Project task items or import them as dashboard tasks.
- Do not automatically close Issues when a PR is opened or merged.
- Do not invent an Issue number for this change; the handoff needs an operator-provided or explicitly
  created tracking Issue.
- Do not change Project status mappings or duplicate-prevention behavior.

## Requirements and acceptance criteria

- The global and repository `lld-driven-development` skills require a canonical Issue for every PR.
- The default workflow and PR template require an explicit `Refs #<number>` or Issue URL.
- The PR validator rejects a body with no Issue reference.
- `createPullRequest()` fails closed when the task has no `issueNumber` and includes `Refs #<number>`
  in generated PR bodies when it does.
- Regression tests cover accepted/rejected PR bodies and generated PR linkage.
- Existing Issue-only Project sync remains unchanged and no PR Project item is created.

## Existing architecture and affected boundaries

- `.agents/skills/lld-driven-development/SKILL.md` and `~/.agents/skills/lld-driven-development/SKILL.md` — agent development and handoff contract.
- `workflows/default/WORKFLOW.md` and `.github/pull_request_template.md` — repository handoff contract.
- `scripts/pr-template.mjs` — PR body validator used before remote writes.
- `src/lib/server/github.ts` — application-generated PR body and preflight guard.
- `tests/pr-template.test.ts` and `tests/github-status-sync.test.ts` — regression coverage.
- `README.md` and `docs/architecture.md` — contributor-facing source-of-truth explanation.

## Proposed design

The canonical task Issue remains the sole Project board work item. Every PR body must contain a
non-closing GitHub Issue reference in one of these forms:

```text
Refs #123
```

or a full Issue URL. The PR template validator checks this contract before create/update. The live
orchestrator already receives a task with an Issue identity for normal Live task creation; the
GitHub adapter will reject any missing identity rather than falling back to a local task ID.

Generated PRs will contain:

```text
Refs #<issue-number>

Automated handoff for task #<issue-number>.
```

The adapter continues to publish the PR URL and commit summary back to the Issue. No
`addProjectV2ItemById` call is made for the PR.

## Data and state transitions

```text
canonical Issue -> Issue Project item -> isolated task run -> PR with Refs #<issue> -> Issue comment
```

There is no schema migration. The existing task Issue identity is the join key; missing identity is
an error, not a second local or Project-board item.

## Affected files and boundaries

| Area | Files | Change |
| --- | --- | --- |
| Agent policy | Global/local LLD skill, workflow | Make Issue linkage mandatory and non-closing. |
| PR handoff | Template, validator, README/architecture | Document and validate `Refs #<number>` or an Issue URL. |
| Runtime | `src/lib/server/github.ts` | Require Issue identity and include the explicit reference in generated PRs. |
| Tests/docs | PR-template and GitHub adapter tests, this LLD | Cover both policy and runtime failure/success paths. |

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| A task has no Issue identity | Fail before PR creation and keep the run/workspace available for correction. |
| `Refs #123` points to the wrong repository | Require the task Issue to belong to the managed repository; use a full URL where cross-repository context is possible. |
| A PR is linked with `Closes` accidentally | Templates and generated bodies use `Refs`, and reviewers verify non-closing linkage. |
| Existing PR body lacks a reference | Treat it as a pre-policy handoff; future create/update validation rejects it until corrected with a real Issue. |
| GitHub Project automation adds PRs | Keep the application integration Issue-only; document that PR auto-add workflows must remain disabled for this board. |

Rollback reverts the policy, validator, runtime guard, tests, docs, and LLD. No remote Project item
or Issue is deleted by this change.

## Validation plan

1. Test the PR validator with a valid Issue reference and a missing-reference rejection.
2. Test generated PR body linkage and missing-task-Issue rejection with mocked GitHub requests.
3. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` through `safe-run`.
4. Read back global/local policy files and verify the hard-stop/Issue-only rules remain present.
5. Validate a complete PR body and verify the remote PR metadata after handoff.

### Validation results

- Global/local LLD policy readback: verified the canonical Issue, `Refs #<number>`, Issue-only board,
  and fail-before-PR rules.
- Hard-stop verifier: passed.
- `npm test`: passed, 26 tests and 0 failures.
- `npm run typecheck`: passed.
- `npm run build`: passed. The existing non-fatal Turbopack NFT tracing warning references
  `next.config.mjs` and `src/lib/server/db.ts`; it is unrelated to this policy change.
- `git diff --check`: passed.
- PR #29 remote verification: passed with state `open`, base `main`, head
  `fix/issue-linked-pr-handoff`, and URL `https://github.com/maxlee98/project-agent-control-plane/pull/29`.
- PR #29 body template verification: passed and contains the non-closing `Refs #28` linkage.
- No Project PR item was created: the PR handoff uses the Pull Requests API only, and the Project
  integration path/tests add and reconcile Issues only.

## Decision log

- 2026-08-21: The Project board is intentionally Issue-only; PRs are linked artifacts, not separate
  board tasks.
- 2026-08-21: Use `Refs #<number>` instead of `Closes #<number>` to avoid changing Issue lifecycle
  merely because a PR was opened.
- 2026-08-21: Update the existing LLD-driven-development skill rather than create a duplicate skill
  name; enforce the same invariant in the template validator and runtime adapter.
- 2026-08-21: Issue #28 was supplied as the canonical tracking Issue; PR #29 was created with
  `Refs #28` and remains open for human review.

## Open questions and assumptions

- Issue #28 is the canonical tracking Issue for this policy change and must be referenced by its PR.
- Assumption: normal Live task creation creates and persists a repository Issue before the agent can
  reach PR handoff.
- Open question: whether a future GitHub App/webhook should automatically reject or label manually
  created PRs that lack Issue references.

## Completion checklist

- [x] Design reviewed
- [x] Global and repository LLD skill updated
- [x] PR template and validator updated
- [x] Runtime PR guard/link updated
- [x] Tests, typecheck, build, and diff checks passed
- [x] LLD and handoff documentation updated
- [x] Tracking Issue #28 and PR #29 linkage verified
- [ ] Human review and merge approval remain pending