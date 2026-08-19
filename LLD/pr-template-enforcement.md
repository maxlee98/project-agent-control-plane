# LLD: Enforce the Pull Request Template

## Status

- **Status:** Implemented; pending review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-20
- **Related task or issue:** Make every agent-created pull request use the compulsory repository PR template.

## Problem and observed evidence

The repository has `.github/pull_request_template.md`, but GitHub does not inject that template into
pull requests created through the REST API. PR #12 was created by an ad-hoc helper body and omitted
the required task/LLD references, changed-boundaries table, migration/compatibility section, UX
evidence, security checklist, risks, and reviewer checklist.

## Goals

1. Correct PR #12 with the complete template structure and accurate content.
2. Make future agent-created PRs load and validate the repository template before creation.
3. Add a CI gate that rejects PR bodies missing required headings or containing unresolved template
   placeholders.
4. Keep PR creation quote-safe, idempotent, credential-safe, and compatible with the terminal
   hard-stop runner.

## Non-goals

- Do not merge PRs automatically.
- Do not change GitHub branch protection settings through this task.
- Do not require screenshots for backend/docs/configuration work; require an explicit N/A reason.
- Do not duplicate the template in multiple independent documents.
- Do not read `.env.local`, print credentials, or put credentials in PR bodies.

## Requirements and acceptance criteria

- PR #12 contains every heading from `.github/pull_request_template.md` and no unresolved HTML
  placeholder comments.
- `scripts/create-pr.mjs` loads the template contract, validates a supplied body file, queries for
  an existing PR before creating, and uses the Git credential helper only in memory when needed.
- `scripts/verify-pr-template.mjs` validates a local PR body without network access or secrets.
- `.github/workflows/validate-pr-template.yml` runs on pull-request events and fails when required
  headings are missing or unresolved placeholders remain.
- `AGENTS.md` and `workflows/default/WORKFLOW.md` make template use compulsory and forbid ad-hoc
  abbreviated PR payloads.
- PR #12 is updated and verified open without merging.

## Existing architecture and affected boundaries

- `.github/pull_request_template.md` — single PR body contract.
- `.github/workflows/validate-pr-template.yml` — server-side enforcement gate.
- `scripts/create-pr.mjs` — quote-safe REST PR creator.
- `scripts/verify-pr-template.mjs` — local validator.
- `scripts/pr-template.mjs` — shared template heading and checklist validator.
- `AGENTS.md`, `workflows/default/WORKFLOW.md` — agent behavior contract.
- PR #12 — existing remote body to repair.

## Proposed design

### Template validator

The validator reads the template headings and checks that the candidate body contains each required
heading. It rejects unresolved HTML comments, empty required checkboxes, and missing validation
results. It reports only missing section names and never prints the candidate body or secrets.

### PR creator

The generic creator requires a patch-created body file and explicit `--title`, `--head`, and `--base`
arguments. It validates the body locally, queries open PRs by head branch, and creates only when no
matching PR exists. A separate update mode repairs an existing PR body after querying its number.

### CI gate

The workflow checks the PR body from the GitHub event payload through a small Node script. It does not
need credentials and fails closed when the body is incomplete. The workflow is a review gate, not an
automatic merge mechanism.

## Data and state transitions

```text
template file -> body file -> local validator -> safe PR helper -> query existing PR
                                                         -> create/update PR
                                                         -> CI template gate
```

```text
PR created -> human review -> merge remains human-controlled
```

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| GitHub API does not auto-apply template | Helper validates against the checked-in template before every write. |
| Existing PR has an incomplete body | Explicit update mode repairs it; CI reports failure until corrected. |
| Template headings change | Validator derives required headings from the canonical template. |
| API request is interrupted | Query by head before retrying; never blindly create a duplicate. |
| Git credential helper unavailable | Fail before remote write with a non-secret configuration error. |
| CI body contains secret-like content | Existing repository security rules remain authoritative; validator never logs the body. |

Rollback reverts helper, verifier, workflow, documentation, and LLD changes. The corrected PR body
can be restored only by another explicit, template-validated update.

## Validation plan

1. Unit-test missing headings, unresolved placeholders, valid body, and empty required checkboxes.
2. Validate the generated PR #12 body locally without printing it.
3. Run the CI validator locally against the same body.
4. Update PR #12 through the quote-safe helper and query it again.
5. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` through `safe-run`.
6. Verify branch/PR state and no merge.

## Decision log

- 2026-08-20: PR #12 omitted required template sections because REST PR creation does not auto-apply `.github/pull_request_template.md`.
- 2026-08-20: The checked-in template remains the single source of truth; helpers validate against it instead of duplicating it.
- 2026-08-20: CI enforcement is required because local agent helpers can otherwise be bypassed.

## Open questions and assumptions

- Assumption: repository maintainers can enable the CI status as a required branch-protection check after review.
- Assumption: task and LLD references are available to the agent before PR creation.
- Open question: whether PR creation should eventually be moved entirely into the control-plane server rather than local helpers.

## Completion checklist

- [x] Design reviewed
- [x] PR #12 corrected with complete template
- [x] Generic PR helper and validator implemented
- [x] CI template gate added
- [x] Agent workflow rules updated
- [x] Tests, typecheck, build, and diff checks passed
- [x] PR #12 verified open without merge

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 18 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed with the existing
  non-fatal Turbopack NFT tracing warning through `next.config.mjs` and `src/lib/server/db.ts`.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- `scripts/verify-pr-template.mjs` — passed against the complete PR #12 body.
- PR #12 body update — verified open at
  `https://github.com/maxlee98/project-agent-control-plane/pull/12`, base
  `fix/github-task-status-reconciliation`; no merge performed.