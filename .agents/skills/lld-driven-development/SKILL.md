# Repository LLD-Driven Development

Use this skill for every feature, bug fix, refactor, integration, configuration change, test,
documentation change, or agent-harness change in this repository.

## Mandatory phase gates

1. **Intake:** identify the repository, user-visible outcome, constraints, acceptance criteria, and non-goals.
2. **Design:** verify the canonical GitHub Issue, then create or update
   `LLD/<issue-number>-<task-slug>.md` before implementation. Do not use a PR number, local task ID,
   branch name, or commit hash as the filename prefix.
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
- Every implementation PR MUST explicitly link one canonical GitHub Issue for the task with
  `Fixes #123` or `Closes #123`; an LLD link, URL, or ordinary Issue mention alone is not sufficient.
  The closing keyword intentionally creates the GitHub Development relationship and closes the Issue
  when the PR merges.
- Keep the GitHub Project board Issue-only: the PR is a linked implementation artifact of the Issue,
  not a second Project task item. Never add the PR separately unless a task-specific LLD explicitly
  changes that policy.
- If a task has no canonical Issue identity, stop before PR creation and resolve the task linkage;
  never substitute a local task ID or invent an Issue number.
- New Issue-backed LLDs MUST use the exact lowercase kebab-case filename pattern
  `LLD/<issue-number>-<task-slug>.md`. Verify the Issue before creating the file. Historical LLDs
  without a verifiable Issue identity may remain under an explicitly documented legacy filename.
- Never merge automatically; a human reviewer owns approval and merge.
- Treat missing or interrupted command output as unknown and inspect state before retrying.