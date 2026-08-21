# LLD: Consistent Issue Template

## Status
- Status: Complete
- Owner: Project Agent Control Plane
- Date: 2026-08-21
- Related task or issue: Create a reusable template for issues created by agents.

## Problem
Issues created for this repository currently do not have a checked-in default structure. As a
result, agent-created issues can omit important context or use inconsistent sections, making them
harder to triage and implement.

## Goals
- Provide one reusable GitHub Markdown template for agent-created issues.
- Prompt issue authors for the task context needed for implementation and review.
- Keep the template generic enough to support feature, bug, documentation, configuration, and
  other task types without maintaining separate templates for each type.
- Make the template visible to GitHub's new-issue flow without changing application behavior.

## Non-goals
- Do not change the GitHub API client or dynamically rewrite issue bodies in this task.
- Do not add labels, project fields, automation, or a required issue-form schema.
- Do not create separate templates for individual issue types.
- Do not modify existing issues.

## Requirements and acceptance criteria
- A repository-scoped GitHub issue template is checked in under `.github/`.
- The template includes prompts for the problem, goals, non-goals, acceptance criteria, relevant
  context, implementation notes, validation, risks, and follow-ups.
- The template has no credentials or environment values, and its author guidance is kept in HTML
  comments so it is not submitted as task content.
- GitHub can discover the template using the supported default issue-template location.
- Existing application, test, and build behavior remains unchanged.

## Existing architecture
- `.github/pull_request_template.md` is the repository's existing single-source Markdown template
  for pull requests.
- `src/lib/server/github.ts` creates Issues through the GitHub API using caller-supplied title and
  body values. It does not currently load a repository template.
- GitHub is the durable source of truth for Issues; the local control plane stores execution state.
- No `.github/ISSUE_TEMPLATE.md` or `.github/ISSUE_TEMPLATE/` directory currently exists.

## Proposed design
Add `.github/ISSUE_TEMPLATE.md` as the single generic Markdown template used by GitHub's issue
creation flow. Use HTML comments for author guidance so prompts do not become noisy issue content,
and use consistent headings for the information agents and reviewers need. Keep the file type
agnostic by asking the author to identify the task type rather than selecting a dedicated template.

The API client remains unchanged: callers that create Issues programmatically can supply the same
structure explicitly or use a future template-loading enhancement, but this task only establishes
the repository-level GitHub template.

## Data and state transitions
There is no application data or state transition. GitHub presents the checked-in Markdown as the
starting issue body; an author replaces the guidance with task details and submits the Issue. No
existing Issue, local task, project item, or API contract is mutated by the template itself.

## Affected files and boundaries
- `.github/ISSUE_TEMPLATE.md`: new repository-level default Issue body template.
- `tests/issue-template.test.ts`: structural and sensitive-content regression coverage.
- `LLD/consistent-issue-template.md`: design, scope, and validation record.

## Risks, edge cases, and rollback
- **Risk:** Authors may leave guidance comments or sections incomplete. **Mitigation:** Use clear,
  concise prompts and explicit acceptance-criteria bullets.
- **Risk:** GitHub's template discovery differs between Markdown and issue-form templates.
  **Mitigation:** Use the supported root `.github/ISSUE_TEMPLATE.md` Markdown location for one
  default template, and validate the file path and content locally.
- **Risk:** Programmatic Issue creation will not automatically consume a repository template.
  **Mitigation:** Record this boundary explicitly; keep API changes out of scope for this focused
  repository configuration change.
- **Rollback:** Delete `.github/ISSUE_TEMPLATE.md`; no runtime or persisted data rollback is needed.

## Validation plan
- Inspect the new file and verify all required sections are present.
- Run `git diff --check`.
- Run `npm test`, `npm run typecheck`, and `npm run build` because the repository contract requires
  the configured project checks even though this is a Markdown-only change.

## Decision log
- 2026-08-21: Chose one root `.github/ISSUE_TEMPLATE.md` Markdown template instead of a directory
  of type-specific templates because the request calls for one consistent template for future
  agent-created Issues.
- 2026-08-21: Kept the GitHub API client unchanged; the requested outcome is repository template
  availability, not a new body-generation abstraction.

## Open questions and assumptions
- Assumption: The desired behavior is GitHub's default new-Issue body template rather than automatic
  templating of every REST API request made by the application.
- Assumption: A Markdown template is preferable to a structured issue form because the task requests
  one general template that can accommodate multiple task types.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [ ] Tests, typecheck, and build passed (build has an unrelated pre-existing prerender failure; see validation results)
- [x] Documentation updated
- [ ] Handoff verified

## Validation results
- `npm run safe:run -- --timeout-ms 120000 -- node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/issue-template.test.ts` — passed, 2 tests.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm ci` — passed; installed dependencies. npm reported 20 audit vulnerabilities and Node 23 engine warnings for transitive packages.
- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 28 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — failed during existing page prerendering with `TypeError: Cannot read properties of null (reading 'useContext')` for `/_global-error`; compilation and TypeScript completed successfully. The output also includes existing NFT tracing and React key warnings.
