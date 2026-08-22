# LLD: Include GitHub Issue Numbers in LLD Filenames

## Status

- **Status:** Complete; pending human review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** [Issue #23](https://github.com/maxlee98/project-agent-control-plane/issues/23) — “LLDs should have the issue tagged to them”

## Problem and observed evidence

Before this change, LLD documents used descriptive filenames without the canonical GitHub Issue
number in the path. A repository search could therefore not identify the tracking Issue from an LLD
filename alone, and similarly named designs were harder for a human to trace back to their source
task. The workflow and PR template also described the filename using a task slug only, which did not
establish an Issue-linked naming convention.

## Goals

1. Establish `LLD/<issue-number>-<task-slug>.md` as the canonical filename for Issue-backed LLDs.
2. Rename existing LLDs when their canonical GitHub Issue identity is verified, preserving each
   document’s content and links.
3. Make the naming rule visible in the repository workflow, LLD skill, README, PR template, and
   contributor-facing architecture guidance.
4. Add a regression test that prevents future Issue-backed LLD filenames from dropping the number.
5. Keep historical LLDs whose original task has no verifiable GitHub Issue traceable without inventing
   an Issue number.

## Non-goals

- Do not create, renumber, close, or otherwise modify GitHub Issues as part of this repository change.
- Do not rewrite LLD content or application/runtime behavior unrelated to filename references.
- Do not infer an Issue number from a pull-request number, local task ID, branch name, or commit hash.
- Do not change the PR requirement for an explicit `Fixes #<number>` or `Closes #<number>` linkage.
- Do not remove historical LLDs or make their designs depend on unavailable remote metadata.

## Requirements and acceptance criteria

- New Issue-backed LLDs use the exact lowercase pattern `LLD/<issue-number>-<task-slug>.md`.
- The Issue number is a positive decimal number and the slug remains lowercase kebab-case.
- Existing LLD filenames with a verified canonical Issue number are migrated to the new pattern.
- All repository links and instructions point to the renamed paths; no stale renamed-path references
  remain in tracked documentation, tests, or configuration.
- A repository test checks the naming convention and documents the explicit legacy exception for
  pre-issue-tracking LLDs that have no verified Issue identity.
- Validation passes without changing application APIs, persistence, or remote Issue state.

## Existing architecture and affected boundaries

- `LLD/` is the durable design-document directory and the filename is the human-readable discovery
  boundary.
- `.agents/skills/lld-driven-development/SKILL.md`, `AGENTS.md`, and `workflows/default/WORKFLOW.md`
  define the agent design and handoff contract.
- `README.md`, `docs/architecture.md`, and `.github/pull_request_template.md` describe the filename
  and LLD reference convention to contributors and reviewers.
- `tests/` contains repository contract tests and is the appropriate boundary for protecting the
  filename convention without runtime coupling.

## Proposed design

Use an issue-first filename convention:

```text
LLD/<issue-number>-<task-slug>.md
```

For this task, the canonical path is:

```text
LLD/23-llds-should-have-the-issue-tagged-to-them.md
```

The LLD skill and repository workflow will require the Issue number to be verified before an LLD is
created. Existing documents with clear Issue evidence will be renamed and all repository references
will be updated. The verified migration set is Issues #10 (two existing designs for the same tracked
task), #18, #19, #21, #22, #25, #26, #28, #35, #36, #37, and #42, plus this Issue #23 document.
Older policy and implementation-history documents with no verifiable canonical Issue will remain
under their current descriptive names and be listed in the contract test as an intentional legacy
set; future LLDs may not add to that set.

The regression test will read the `LLD/` directory, assert the filename pattern for migrated/current
documents, assert the expected legacy allowlist, and verify that the task LLD has the canonical
Issue prefix. It will not call GitHub or inspect credentials.

## Data and state transitions

No application or database state changes. The document lifecycle is:

```text
verified GitHub Issue + task slug
  -> create LLD/<issue-number>-<task-slug>.md
  -> reference the exact path in workflow/PR/docs
  -> rename only with repository-wide link updates when a legacy Issue identity is verified
```

If an existing document has no verified Issue identity, it remains a legacy descriptive path rather
than receiving a guessed number.

## Affected files and boundaries

- `LLD/*.md`: rename Issue-backed documents and update their internal self-references/status notes;
  retain the explicit seven-file legacy allowlist for pre-issue-tracking designs.
- `.agents/skills/lld-driven-development/SKILL.md`: define the Issue-first filename format and fail
  closed when the canonical Issue is unavailable.
- `AGENTS.md`, `workflows/default/WORKFLOW.md`, `README.md`, `docs/architecture.md`, and
  `.github/pull_request_template.md`: expose the filename convention and exact links.
- `tests/lld-naming.test.ts`: protect the naming contract and explicit legacy allowlist.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| A rename leaves a stale Markdown link | Search tracked files for every old basename and run the naming/link test. |
| A local task ID is mistaken for a GitHub Issue | Require remote Issue verification and do not use PR numbers or local IDs. |
| An old LLD has no canonical Issue | Keep it in a documented legacy allowlist; do not fabricate an identity. |
| A filename is valid but its slug is not human-readable | Require lowercase kebab-case and preserve the descriptive task slug. |
| External bookmarks use the old path | Git history preserves the rename and the PR documents the migration; no runtime path depends on LLD filenames. |

Rollback is a documentation-only revert of the renames, references, guidance, and contract test. No
database, application, GitHub Issue, Project, PR, or deployment rollback is required.

## Validation plan

1. Verify Issue #23 and inspect existing LLD references before editing.
2. Rename only documents with a verified canonical Issue identity and update repository references.
3. Run the focused LLD naming test.
4. Run `npm test`, `npm run typecheck`, and `npm run build` through `safe-run`.
5. Run `git diff --check`, inspect the final rename/link diff, and verify no credentials or environment
   files changed.
6. Verify branch freshness, validate the complete PR template, and hand off through the repository PR
   script without merging.

## Decision log

- **2026-08-22:** Use `<issue-number>-<task-slug>.md` rather than `#<number>-...` because the
  number-first path remains shell/URL friendly while retaining human-readable Issue traceability.
- **2026-08-22:** Treat the GitHub Issue number as canonical; PR numbers, local task IDs, branches,
  and commit hashes are not acceptable substitutes.
- **2026-08-22:** Migrate verifiable Issue-backed LLDs and preserve pre-policy documents without a
  verifiable Issue as an explicit legacy exception rather than inventing remote identities.
- **2026-08-22:** Verified the migration set from explicit LLD metadata, exact Issue title/body
  matches, and existing Issue/PR history. The legacy set is `agent-liveness-and-project-deduplication`,
  `branch-freshness-enforcement`, `pr-first-development-and-template`, `pr-template-enforcement`,
  `scripted-edit-reliability`, `skill-hardening`, and `terminal-hard-stop-enforcement`.

## Open questions and assumptions

- **Assumption:** Issue #23 is the canonical tracking Issue for this change and remains open until the
  implementation PR merges.
- **Assumption:** Lowercase kebab-case task slugs are the repository’s intended human-readable style.
- **Open question:** Historical legacy LLDs may be migrated later if maintainers establish canonical
  Issue identities for their original work; that follow-up is not inferred in this task.

## Completion checklist

- [ ] Design reviewed
- [x] Verified Issue-backed LLDs renamed
- [x] Workflow, skill, PR, README, and architecture references updated
- [x] LLD naming regression test added
- [x] Implementation self-review completed
- [x] Tests, typecheck, and diff checks passed; production build retains a pre-existing failure
- [x] LLD updated with actual validation results
- [ ] Issue-linked PR created and remotely verified
- [ ] Human merge approval remains pending

## Validation results

- Verified Issue #23 is open at `https://github.com/maxlee98/project-agent-control-plane/issues/23`.
- `node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/lld-naming.test.ts` — passed, 2 tests.
- `npm install` — completed successfully to restore dependencies; npm reported existing audit,
  deprecation, and Node 23 engine warnings. No dependency files changed.
- `npm test` — passed, 70 tests, 0 failures.
- `npm run typecheck` — passed without TypeScript diagnostics.
- `npm run build` — compiled and typechecked, but failed during prerendering of `/_global-error`
  with the pre-existing React `useContext` null error; the existing Turbopack NFT tracing warning
  and React key warnings were also reported.
- `git diff --check` — passed.
- Repository-wide search — verified old Issue-backed LLD paths no longer remain in tracked links;
  the only descriptive LLD paths remaining are the seven explicit legacy exceptions and historical
  references to the legacy document.

## Handoff notes

- Implementation commit: `71d5311` (`docs: prefix LLD filenames with issue numbers`).
- Feature branch: `agent/23-LLDs-should-have-the-issue-tagged--594c652d`; it is one commit ahead of
  the local `origin/main` snapshot. Remote freshness must be rechecked after publishing the branch.
- PR creation remains pending because the branch has not yet been pushed and the required PR body
  must use the renamed canonical LLD path plus `Fixes #23`.