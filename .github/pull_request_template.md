## Task and design references

- **Task:** <!-- Required: link the canonical GitHub Issue/control-plane task with `Fixes #<issue-number>` or `Closes #<issue-number>`. An LLD link or ordinary mention alone is not sufficient. -->
- **LLD:** <!-- Link `LLD/<task-slug>.md`; explain if this is a docs-only exception. -->
- **PR type:** <!-- Match the title prefix: feat / fix / docs / refactor / test / chore / perf / build / ci / revert -->

Pull request titles must use `<type>: <description>` format, for example `feat: add task filtering`
or `fix(api): prevent duplicate handoffs`.

## Problem

<!-- What was observed? Who or what is affected? Include evidence without secrets or raw credentials. -->

## Goals and non-goals

### Goals

-

### Non-goals

-

## Design and implementation

<!-- Explain the chosen approach, important decisions, state transitions, and error handling. -->

## Changed files and boundaries

<!-- List meaningful files/modules and why they changed. Call out API, domain, persistence, UI, workflow, or integration boundaries. -->

| Area | Files | Summary |
| --- | --- | --- |
| Domain/API | | |
| Persistence | | |
| UI/UX | | |
| Tests/docs/config | | |

## Data, migrations, and compatibility

- **Schema/data migration:** <!-- None, or describe it and rollback/recovery. -->
- **Backward compatibility:** <!-- Explain behavior for existing databases, APIs, or users. -->
- **Remote side effects:** <!-- Branches, PRs, GitHub comments, deployments, or None. -->

## Validation

List the commands actually run and their results. Do not write “will test” or claim checks that
were not observed.

- [ ] `npm test` — result:
- [ ] `npm run typecheck` — result:
- [ ] `npm run build` — result:
- [ ] `git diff --check` — result:
- [ ] Other checks — result:

## UX evidence

<!-- Add screenshots, recordings, API examples, or “Not applicable” with a reason. Do not include secrets. -->

## Security and secrets review

- [ ] No `.env`, `.env.local`, tokens, API keys, authorization headers, or sensitive raw logs were added.
- [ ] New inputs, outputs, logs, and remote requests follow existing redaction/security boundaries.
- [ ] Any security limitation or follow-up is documented here and in the LLD.

## Risks, rollback, and follow-ups

- **Risks:**
- **Rollback/recovery:**
- **Known warnings:**
- **Follow-up tasks:**

## Reviewer checklist

- [ ] The problem and acceptance criteria are clear.
- [ ] The implementation matches the linked LLD and stays within scope.
- [ ] Domain/source-of-truth boundaries are preserved.
- [ ] Tests and validation results are real and sufficient.
- [ ] Error, interruption, rollback, and security behavior are addressed.
- [ ] Documentation and task status are ready for handoff.
- [ ] Human review is complete before merge.