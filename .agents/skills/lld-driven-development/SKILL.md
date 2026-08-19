# Repository LLD-Driven Development

Use this skill for every feature, bug fix, refactor, integration, configuration change, test,
documentation change, or agent-harness change in this repository.

## Mandatory phase gates

1. **Intake:** identify the repository, user-visible outcome, constraints, acceptance criteria, and non-goals.
2. **Design:** create or update `LLD/<task-slug>.md` before implementation.
3. **Implementation:** reread the LLD before editing and update it when scope or decisions change.
4. **Verification:** run bounded checks through `npm run safe:run` and record actual results.
5. **Handoff:** summarize files, checks, warnings, branch, PR, and remaining human decisions.

On context resumption, reread the active LLD before making another design or code decision.

## Required self-review

Before handoff, verify readability, modularity, testability, domain/source-of-truth alignment,
security, and repository/framework conventions. Fix findings or record them as LLD follow-ups.

## Handoff rules

- Work on a dedicated branch; never push directly to `main`.
- Create and update PRs only through the template-validating `scripts/create-pr.mjs` flow.
- Never merge automatically; a human reviewer owns approval and merge.
- Treat missing or interrupted command output as unknown and inspect state before retrying.