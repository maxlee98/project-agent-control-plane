# LLD: Issue-Linked Pull Request Handoff

## Status

- **Status:** Complete; explicit closing-linkage follow-up in progress
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-21
- **Related task or issue:** https://github.com/maxlee98/project-agent-control-plane/issues/28
- **Follow-up behavior verified against:** https://github.com/maxlee98/project-agent-control-plane/issues/21

## Problem and observed evidence

The repository correctly treats GitHub Issues and Projects V2 items as task state, and the Project
sync ignores Pull Request content. The initial Issue-linkage policy required only a non-closing
reference, so a generated PR could mention the Issue without creating the GitHub Development
relationship. The initial application PR handoff also included a descriptive duplicate Issue
mention, making the relationship ambiguous and the generated body noisy.

## Goals

1. Require every implementation PR to reference one canonical GitHub Issue.
2. Keep the Projects V2 board Issue-only: one task has one Issue Project item; its PR is linked to
   that Issue and is not added as a second task card.
3. Use an explicit closing reference such as `Fixes #123` or `Closes #123` so GitHub creates the
   Development relationship and the Issue-only Project item can move to Done on merge.
4. Enforce the policy in agent guidance, PR-template validation, and application-generated PRs.
5. Reject missing Issue identity before a live PR is created.

## Non-goals

- Do not add Pull Requests as Project task items or import them as dashboard tasks.
- Closing the canonical Issue on merge is intentional for generated implementation PRs; do not add
  the Pull Request as a separate Project task item.
- Do not invent an Issue number for this change; the handoff needs an operator-provided or explicitly
  created tracking Issue.
- Do not change Project status mappings or duplicate-prevention behavior.

## Requirements and acceptance criteria

- The global and repository `lld-driven-development` skills require a canonical Issue for every PR.
- The default workflow and PR template require an explicit `Fixes #<number>` or `Closes #<number>`
  linkage; an ordinary mention or URL alone is not sufficient.
- The PR validator rejects a body with no Issue reference.
- `createPullRequest()` fails closed when the task has no `issueNumber` and includes one `Fixes
  #<number>` reference in generated PR bodies when it does.
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

The canonical task Issue remains the sole Project board work item. Every generated PR body must
contain one closing GitHub Issue reference in one of these forms:

```text
Fixes #123
```

or:

```text
Closes #123
```

The PR template validator checks this contract before create/update. A full Issue URL or ordinary
mention identifies an Issue but does not create the Development relationship and is therefore not
accepted as the generated linkage. The live orchestrator already receives a task with an Issue
identity for normal Live task creation; the GitHub adapter will reject any missing identity rather
than falling back to a local task ID.

Generated PRs will contain:

```text
Fixes #<issue-number>
```

or:

```text
Closes #<issue-number>
```

The adapter continues to publish the PR URL and commit summary back to the Issue. No
`addProjectV2ItemById` call is made for the PR.

## Data and state transitions

```text
canonical Issue -> Issue Project item -> isolated task run -> PR with Fixes #<issue> -> Issue comment
```

There is no schema migration. The existing task Issue identity is the join key; missing identity is
an error, not a second local or Project-board item.

## Affected files and boundaries

| Area | Files | Change |
| --- | --- | --- |
| Agent policy | Global/local LLD skill, workflow | Make explicit closing Issue linkage mandatory. |
| PR handoff | Template, validator, README/architecture | Document and validate `Fixes`/`Closes #<number>`. |
| Runtime | `src/lib/server/github.ts` | Require Issue identity and include the explicit reference in generated PRs. |
| Tests/docs | PR-template and GitHub adapter tests, this LLD | Cover both policy and runtime failure/success paths. |

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| A task has no Issue identity | Fail before PR creation and keep the run/workspace available for correction. |
| `Fixes #123` points to the wrong repository | Require the task Issue to belong to the managed repository; generated PRs use the canonical same-repository Issue. |
| A PR should be linked without closing its Issue | The manual Development action is required; generated implementation PRs intentionally use `Fixes`/`Closes` for automatic linkage. |
| A generated body repeats the Issue number | Keep the closing reference as the only `#<issue>` token in the handoff preamble; do not add a descriptive duplicate. |
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

- Global/local LLD policy readback: verified the canonical Issue, explicit closing linkage,
  Issue-only board, and fail-before-PR rules.
- Historical PR #29 validation: passed under the former non-closing `Refs #28` policy; that body
  remains historical evidence and is not the generated format going forward.
- Current focused linkage tests: passed, 13 tests and 0 failures.
- Current `npm test`: passed, 33 tests and 0 failures.
- Current `npm run typecheck`: passed.
- Current `npm run build`: passed. The existing non-fatal Turbopack NFT tracing warning references
  `next.config.mjs` and `src/lib/server/db.ts`; it is unrelated to this policy change.
- Current `git diff --check`: passed.
- Historical PR #29 remote verification: passed with state `open`, base `main`, head
  `fix/issue-linked-pr-handoff`, and URL `https://github.com/maxlee98/project-agent-control-plane/pull/29`.
- Historical PR #29 body template verification: passed and contains the former non-closing `Refs #28`
  linkage.
- No Project PR item was created: the PR handoff uses the Pull Requests API only, and the Project
  integration path/tests add and reconcile Issues only.
- Follow-up implementation validation: the generated body now contains one `Fixes #<issue>` token;
  the validator rejects URL-only and `Refs`-only mentions because they do not create the Development
  relationship.

## Decision log

- 2026-08-21: The Project board is intentionally Issue-only; PRs are linked artifacts, not separate
  board tasks.
- 2026-08-21: The original policy used `Refs #<number>` to avoid changing Issue lifecycle merely
  because a PR was opened.
- 2026-08-21: Generated implementation PRs now use one `Fixes #<number>` reference. GitHub’s
  supported closing-keyword behavior creates the Development relationship and closes the canonical
  Issue on merge, allowing the Issue-only Project item to move to Done.
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