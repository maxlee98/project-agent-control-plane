# LLD: Create a Consistent Issue Template

## Status

- **Status:** Implemented; pending human review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-21
- **Related task or issue:** [Issue #19](https://github.com/maxlee98/project-agent-control-plane/issues/19) — Create a template for issues created for consistency.

## Problem and observed evidence

The repository has a pull-request template but no `.github/ISSUE_TEMPLATE` directory or issue
template. GitHub issues created through the UI therefore start without a shared structure, and
agent-created issues can use unrelated body formats.

## Goals

1. Provide one generic Markdown issue template that works for feature requests, bugs, maintenance,
   documentation, and other repository tasks.
2. Make the template guide authors toward the context needed for implementation: problem, goals,
   non-goals, acceptance criteria, affected boundaries, validation, risks, and follow-ups.
3. Keep the template usable by both GitHub's issue picker and agents that need to copy the canonical
   body structure when creating an issue programmatically.
4. Prevent ordinary GitHub UI issue creation from silently bypassing the shared structure.

## Non-goals

- Do not create separate bug, feature, or documentation templates.
- Do not change the control-plane issue creation API or rewrite existing issue bodies in this task.
- Do not add labels, assignees, project fields, or automation that require repository-specific
  GitHub configuration.
- Do not require every issue to contain implementation details before triage.

## Requirements and acceptance criteria

- `.github/ISSUE_TEMPLATE/task.md` exists and is recognized by GitHub as a Markdown issue template.
- The template has a clear name and description in its YAML front matter and uses a neutral title
  prefix so it is suitable for any issue type.
- The body contains prompts for summary/context, problem or evidence, goals, non-goals, acceptance
  criteria, affected areas, validation, risks/rollback, and follow-up questions.
- Prompts are HTML comments or concise placeholder text so they do not become misleading issue
  content when an author fills the template in.
- `.github/ISSUE_TEMPLATE/config.yml` disables blank issue creation, leaving the generic template as
  the single standard entry point.
- A repository test verifies the template files and required headings/metadata so future changes do
  not silently remove the consistency contract.

## Existing architecture and affected boundaries

- `.github/pull_request_template.md` is the existing repository contribution-template convention.
- `src/lib/server/github.ts` creates Issues through the GitHub REST adapter, but its API body remains
  caller-provided and is intentionally outside this focused configuration change.
- `tests/` contains repository-level Node tests and is the appropriate boundary for checking the
  checked-in template contract.
- GitHub repository metadata under `.github/ISSUE_TEMPLATE/` is consumed by GitHub; it has no runtime
  or database dependency in the Next.js application.

## Proposed design

Add one generic `task.md` Markdown template with front matter:

```yaml
name: Task
about: Describe a problem, improvement, or piece of work consistently
title: "[Task]: "
labels: ""
assignees: ""
```

The body will use stable `##` headings and HTML comments for author guidance. It will explicitly
allow the author to state “Not applicable” for sections such as validation or rollback when that is
the honest result, rather than forcing irrelevant detail.

Add `config.yml` with `blank_issues_enabled: false` and no contact links. This keeps the repository's
issue entry point focused without introducing a second template or an external support workflow.

Add a test that reads the files without network access and asserts the metadata, required headings,
and blank-issue policy. The test should validate the contract, not exact wording, so the prompts can
be improved without needless test churn.

## Data and state transitions

```text
GitHub New issue -> Task template selected -> author fills prompts -> issue created
                                      \-> blank issue unavailable
Agent/API creation -> caller copies the same canonical headings when a body is supplied
```

The change has no SQLite schema, API, or remote data migration. Existing issues remain unchanged.

## Affected files and boundaries

- `LLD/19-create-consistent-issue-template.md`: durable design and validation record.
- `.github/ISSUE_TEMPLATE/task.md`: canonical generic issue body.
- `.github/ISSUE_TEMPLATE/config.yml`: issue-picker policy that disables blank issues.
- `tests/issue-template.test.ts`: regression coverage for the repository issue-template contract.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| A generic template is too broad for a specific issue | Prompts are optional and authors can state “Not applicable”; triage remains human-controlled. |
| Blank issue creation is disabled for an urgent or unusual report | Re-enable it by changing one config value or revert `config.yml`; no issue data is lost. |
| API-created issues do not automatically consume GitHub UI templates | Keep the template headings stable and documented as the canonical structure; do not claim REST auto-application. |
| Future edits remove a required prompt | The repository test asserts the stable headings and metadata. |

Rollback is a revert of the two `.github/ISSUE_TEMPLATE` files and their test. No database or remote
issue cleanup is required.

## Validation plan

1. Run the focused issue-template test through `safe-run`.
2. Run the full test suite, typecheck, and production build through `safe-run`.
3. Run `git diff --check` through `safe-run`.
4. Review the diff to confirm the template is generic, actionable, and contains no credentials or
   unrelated workflow changes.

## Decision log

- 2026-08-21: Use one Markdown template rather than multiple issue forms because the request asks
  for a single consistent format across issue types.
- 2026-08-21: Disable blank issue creation to make the shared format the default GitHub entry point.
- 2026-08-21: Keep runtime/API issue creation unchanged; GitHub templates are repository metadata,
  and silently changing REST-created body content would be outside this focused task.

## Open questions and assumptions

- Assumption: the repository maintainers want all normal GitHub UI issue creation to use the shared
  template, hence `blank_issues_enabled: false`.
- Assumption: API-created issue bodies will be handled by the calling agent or workflow using the
  checked-in template structure; automatic API body rendering is a separate follow-up.
- Open question: whether a future issue-creation helper should load and render this template for
  non-UI issue creation.

## Completion checklist

- [x] Intake and scope reviewed
- [x] Design recorded before implementation
- [x] Template and configuration implemented
- [x] Regression test added
- [x] Implementation self-review completed
- [x] Focused issue-template test passed
- [x] Full tests and typecheck passed
- [ ] Production build passed (existing prerender failure remains; see validation results)
- [x] Handoff and PR linkage verified

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/issue-template.test.ts` — passed, 2 tests.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 25 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — compiled and typechecked, but failed while prerendering `/_global-error` with `TypeError: Cannot read properties of null (reading 'useContext')`; it also reported existing Turbopack NFT tracing and React key warnings.

## Handoff notes

- The generic Markdown issue template is available at `.github/ISSUE_TEMPLATE/task.md` and blank
  issue creation is disabled in `.github/ISSUE_TEMPLATE/config.yml`.
- No existing issue bodies, runtime API behavior, database schema, credentials, or remote state were
  changed.
- Canonical task linkage is Issue #19; human review and merge approval remain pending.
- Pull request #30 is open at https://github.com/maxlee98/project-agent-control-plane/pull/30 with
  base `main`, head `agent/19-Create-a-template-for-issues-creat-bd5aff1d`, and a verified template
  body. It has not been merged.