# LLD: Standardize Pull Request Title Prefixes

## Status

- **Status:** Ready for PR handoff; human review pending
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** https://github.com/maxlee98/project-agent-control-plane/issues/54

## Problem and observed evidence

Pull request titles are inconsistent: some use Conventional Commit-style prefixes such as `feat:`
and `fix:`, while others contain only a description. The generated Live-mode PR path currently sends
the task title directly to GitHub, and the repository has no title validation gate for manually
created or edited pull requests.

## Goals

1. Define one Conventional Commit-style title format for repository pull requests.
2. Apply a deterministic prefix to application-generated PR titles while preserving a valid prefix
   already present in a task title.
3. Reject unprefixed or unsupported titles in the PR helper and CI validation workflow.
4. Document the accepted prefixes and provide regression coverage for normalization and validation.

## Non-goals

- Do not rewrite historical closed pull request titles.
- Do not add a new task database field or migration solely for PR title type metadata.
- Do not infer a semantic type from arbitrary task prose; untyped generated titles use the documented
  `feat:` default unless an exact supported type is present in task labels.
- Do not change branch naming, commit message, Issue linkage, or PR body policy.

## Requirements and acceptance criteria

- New or edited PR titles must match `<type>[optional(scope)][optional !]: <description>`.
- Supported types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`, and
  `revert`.
- Application-generated titles are prefixed deterministically: an existing supported title prefix is
  retained; otherwise an exact supported task label selects the type, with `feat` as fallback.
- The repository PR helper and GitHub Actions gate reject titles that are missing a prefix, use an
  unsupported type, or have no description.
- Tests cover valid scoped/breaking titles, invalid titles, normalization, and task-label selection.

## Existing architecture and affected boundaries

- `src/lib/server/github.ts` creates Live-mode PRs through GitHub REST.
- `scripts/create-pr.mjs` is the repository-safe PR create/update helper.
- `.github/workflows/validate-pr-template.yml` is the server-side pull request policy gate.
- `.github/pull_request_template.md`, `README.md`, and `workflows/default/WORKFLOW.md` document the
  PR handoff contract.
- `tests/github-status-sync.test.ts` covers generated GitHub PR payloads; `tests/pr-title.test.ts`
  covers the pure policy utility.

## Proposed design

Create a small pure title-policy module in `src/lib/pr-title.ts` with the supported type list,
Conventional Commit title matcher, task-label type selection, normalization, and validation. The
GitHub adapter calls normalization before POSTing a PR. Exact labels such as `fix` or `docs` select
their matching prefix; labels `bug` and `feature` map to `fix` and `feat`; an untyped task defaults
to `feat`. A title already beginning with a supported prefix is preserved after trimming.

The standalone `scripts/pr-title.mjs` contains the same policy for Node-based repository tooling.
`scripts/create-pr.mjs` validates the supplied title before any remote request. The
`validate-pr-template.yml` workflow adds a title check alongside body validation, so manually created
or edited PRs are rejected by CI even when they do not use the helper.

## Data and state transitions

There is no persistence change. At PR handoff, task title and labels are read-only inputs:

```text
task.title + task.labels
  -> normalize generated title
  -> GitHub PR POST/PATCH title
```

For direct helper/workflow validation:

```text
PR title -> validate conventional format -> pass policy gate or fail with actionable error
```

## Affected files and boundaries

- `src/lib/pr-title.ts` — shared application title policy.
- `src/lib/server/github.ts` — normalize generated PR titles.
- `scripts/pr-title.mjs` — Node title policy for safe PR tooling.
- `scripts/create-pr.mjs` — validate titles before remote writes.
- `.github/workflows/validate-pr-template.yml` — validate event PR titles.
- `.github/pull_request_template.md`, `README.md`, `workflows/default/WORKFLOW.md` — document format.
- `tests/pr-title.test.ts`, `tests/github-status-sync.test.ts` — regression coverage.
- `LLD/standardize-pr-title-prefixes.md` — design and validation record.

## Risks, edge cases, and rollback

- A task with no type metadata receives `feat:`, which is predictable but may need a more expressive
  task-type field later. This is documented as a follow-up rather than inferred from prose.
- Existing valid prefixes, scoped prefixes, and breaking-change markers must not be double-prefixed.
- The workflow only gates new/edited PR events; historical titles remain unchanged.
- Rollback is a revert of the policy module, helper/workflow step, and documentation changes. No data
  migration or remote title rewrite is required.

## Validation plan

1. Run title-focused tests, including generated GitHub payload assertions.
2. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` through `safe-run`.
3. Run the PR body validator against the final template-compliant handoff body.
4. Verify branch freshness and remote PR metadata before handoff.

## Decision log

- 2026-08-22: Use Conventional Commit syntax because the repository already has mixed `feat:`/`fix:`
  history and the PR template already classifies PR types.
- 2026-08-22: Keep the supported list explicit and small enough for predictable review; include the
  common `build`, `ci`, `chore`, `docs`, `perf`, `refactor`, `revert`, and `test` types in addition to
  `feat` and `fix`.
- 2026-08-22: Generated PRs use exact task labels when available and `feat` otherwise; task prose is
  not classified heuristically.

## Open questions and assumptions

- Assumption: exact task labels are the only reliable existing type metadata; a future task model may
  expose an explicit PR type.
- Open question: whether maintainers want a narrower allowed type list or scopes enforced beyond the
  current Conventional Commit grammar.

## Completion checklist

- [x] Intake and design recorded
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests and typecheck passed; build has a pre-existing unrelated prerender failure
- [x] Documentation updated
- [ ] PR title policy verified in the remote workflow
- [ ] Human review and merge approval remain pending

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed; 71 tests, 0 failures.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- node --test tests/pr-title.test.ts` — passed; 3 tests.
- `npm run safe:run -- --timeout-ms 120000 -- node scripts/verify-pr-title.mjs --title 'feat: add task filtering'` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- node scripts/verify-pr-title.mjs --title 'Add task filtering'` — rejected as expected.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — failed after successful compilation during
  pre-render of `/_global-error` with `TypeError: Cannot read properties of null (reading 'useContext')`.
  The existing NFT tracing warning and React key warnings were also reported; this failure is unrelated
  to the title-policy files and needs separate investigation.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.