# LLD: PR-First Development and Pull Request Template

## Status

- **Status:** Complete
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-19
- **Related task or issue:** Establish a mandatory pull-request workflow for every repository update, feature, bug fix, documentation change, and configuration change.

## Problem

The repository workflow asks agents to create or update a branch and pull request during handoff,
but it does not make PR-first development mandatory before edits. There is also no standardized PR
body requiring the task context, LLD, design, changed boundaries, validation results, risks, and
reviewer decisions. This makes it possible for work to be committed locally without a visible,
reviewable handoff or for future agents to omit important implementation evidence.

## Goals

1. Require every future repository change to be developed on a dedicated branch and delivered through a PR.
2. Prevent direct implementation commits or pushes to `main`.
3. Standardize PR descriptions so reviewers can understand the problem, design, changes, checks, risks, and follow-ups.
4. Link each PR to its task and LLD for durable context.
5. Preserve human control over merging while making the handoff process explicit and repeatable.

## Non-goals

- Do not add automatic merging or bypass required GitHub reviews/checks.
- Do not require a hosted CI migration; use the existing CI workflow.
- Do not change application runtime behavior.
- Do not require every PR to contain screenshots when the change has no user-facing surface.
- Do not expose credentials, environment files, or sensitive logs in PR bodies.

## Requirements and acceptance criteria

- `.github/pull_request_template.md` exists and requires task/LLD links, problem, goals, design,
  changed boundaries, validation results, risks, security review, and reviewer checklist.
- `workflows/default/WORKFLOW.md` explicitly requires a dedicated branch before edits, forbids
  direct `main` work/pushes, requires the PR template, and prohibits automatic merges.
- `README.md` documents the same PR-first policy for human contributors and agents.
- The policy distinguishes local commit creation from remote push/PR/merge operations and requires
  remote state verification before repeating side effects.
- Documentation passes `git diff --check` and existing project checks remain green.

## Existing architecture

- `workflows/default/WORKFLOW.md` is the versioned agent behavior contract.
- `README.md` is the contributor-facing repository entry point.
- `.github/workflows/ci.yml` provides the existing CI boundary.
- `LLD/` stores durable task designs and final validation records.

## Proposed design

### Branch policy

Before the first edit, an agent must inspect the current branch. If it is `main`, the agent creates
a task-scoped branch. No work should be committed or pushed directly to `main`.

### PR template

The template will require concise but complete sections for:

- Task and LLD references
- Problem, goals, and non-goals
- Design and implementation summary
- Affected files, boundaries, migrations, and compatibility
- Validation commands with actual results
- Security/secrets review
- UX evidence when applicable
- Risks, rollback, follow-ups, and reviewer checklist

### Handoff policy

The agent verifies local state, diff whitespace, tests, typecheck/build, branch, and commit before
push. It queries remote branch/PR state before retrying a possibly successful write. It creates or
updates a PR using the template, reports the URL and checks, and waits for explicit human approval
before any merge.

## Data and state transitions

```text
main detected -> task branch created -> implementation + LLD -> local checks
  -> verified commit -> remote branch push -> PR created/updated -> human review -> explicit merge
```

An interrupted remote operation follows the terminal-reliability unknown-state path:

```text
remote command interrupted -> query branch/PR -> create/update only if absent/stale -> verify URL/status
```

## Affected files and boundaries

- `.github/pull_request_template.md`: required PR body structure.
- `workflows/default/WORKFLOW.md`: agent-enforced branch and handoff policy.
- `README.md`: contributor-facing PR policy.
- `LLD/pr-first-development-and-template.md`: this design and validation record.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| An agent starts on `main` | Require branch inspection and branch creation before the first edit. |
| A push or PR command times out after succeeding | Query the remote branch/PR before retrying. |
| Template becomes too heavy for small docs changes | Keep sections concise and permit “Not applicable” with a reason. |
| Agents merge without review | Explicitly prohibit automatic merge and require human approval. |
| Validation evidence is stale or aspirational | Require actual commands/results and record warnings. |
| Sensitive output is copied into a PR | Require secrets review and prohibit env files, tokens, and raw credentialed logs. |

Rollback is reverting this documentation-only change. It has no runtime or database impact.

## Validation plan

1. Read back the template, workflow policy, and README policy.
2. Check template sections for task/LLD, design, files, checks, security, risks, and reviewer sign-off.
3. Run `git diff --check`.
4. Run `npm test`, `npm run typecheck`, and `npm run build` as separate checks.
5. Create a dedicated branch, commit the policy, push it, and open a PR; verify the remote URL/status.
6. Do not merge automatically.

### Validation results

- `git diff --check`: passed before commit.
- `npm test`: passed; 8 tests passed, 0 failed.
- `npm run typecheck`: completed without TypeScript diagnostics.
- `npm run build`: passed; Next.js compiled and finalized route optimization.
- Existing non-fatal Turbopack NFT tracing warning remains documented and outside this policy-only scope.
- Implementation commit: `58424d3` (`chore: enforce PR-first development workflow`).

## Decision log

- 2026-08-19: PR-first is mandatory for all future repository updates, not only application features.
- 2026-08-19: The template requires exact validation evidence and LLD/task references to preserve context across agent handoffs.
- 2026-08-19: Automatic merge remains prohibited; human review controls the final merge.

## Open questions and assumptions

- Assumption: GitHub is the remote review system for this repository.
- Assumption: the existing CI workflow remains the required automated check boundary.
- Open question: branch protection rules may later enforce this policy remotely; this task establishes the repository contract first.

## Completion checklist

- [x] Design reviewed
- [x] PR template added
- [x] Workflow policy updated
- [x] README policy updated
- [x] Validation passed
- [ ] Policy branch pushed
- [ ] PR opened and verified
- [ ] Merge intentionally left to human approval