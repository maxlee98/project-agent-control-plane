## Task and design references

- **Task:** Fixes #78 — https://github.com/maxlee98/project-agent-control-plane/issues/78. Related parent context: #70 — https://github.com/maxlee98/project-agent-control-plane/issues/70.
- **LLD:** [LLD/78-publish-meaningful-agent-progress-summaries.md](../LLD/78-publish-meaningful-agent-progress-summaries.md)
- **PR type:** Feature / observability and workflow UX

## Problem

GitHub Issue comments and the local Run console mixed useful progress with implementation-level Cline SDK
activity. Humans need a concise operational narrative: whether a run started, which safe workspace and
branch are active, what task or LLD objective is being pursued, what validation found, and what should
happen next. The existing output summary is useful, but tool calls and SDK chatter are not.

## Goals and non-goals

### Goals

- Publish start, workspace, branch, current intent, next action, validation, failure, stop, and handoff data.
- Retain bounded completed agent output summaries in local history and the GitHub Issue progress narrative.
- Remove tool-call, session-start, generic notice, and raw output-start noise from visible run history.
- Apply redaction and bounds at direct Issue, comment, pull-request, activity, and event output boundaries.
- Preserve Demo/live parity, checkpoint throttling, deduplication, and result-authoritative completion.

### Non-goals

- Do not publish raw SDK payloads, prompts, reasoning, tool input/output, credentials, or absolute local paths.
- Do not change the database schema, worktree lifecycle, validation commands, or automatic merge behavior.

## Design and implementation

The host orchestrator now builds an Issue checkpoint projection containing the phase, safe workspace label,
branch, progress, `Now`, `Next`, validation result, changed files, commit, pull request, and bounded blocker
detail. The full absolute workspace path remains local-only in the Run console. Ordinary checkpoints remain
throttled, duplicate rendered content is suppressed, and stopped runs receive a best-effort checkpoint.

The Cline integration retains only bounded completed text summaries as human-facing candidates. Tool
lifecycle events, session-start events, generic notices, output-start events, usage, status, iteration,
snapshot, chunk, and unknown-hook chatter are not persisted into the visible run trace. Legacy persisted
tool/session rows are hidden at read time without a destructive migration. The returned agent result remains
the authority for completion.

Direct GitHub Issue, comment, and pull-request content plus stored human context now passes through the
existing secret-redaction boundary.

## Changed files and boundaries

| Area | Files | Summary |
| --- | --- | --- |
| Domain/API | `src/lib/server/issue-checkpoints.ts`, `src/lib/server/orchestrator.ts` | Add human-readable checkpoint fields and host-owned lifecycle/intent/next-action publication. |
| Persistence | `src/lib/server/repository.ts` | Hide legacy tool/session events from visible reads and redact stored human context. |
| UI/UX | Run console backend projection | Preserve the existing stable UI contract while removing low-value event noise. |
| Tests/docs/config | `src/lib/server/cline.ts`, `src/lib/server/github.ts`, `tests/`, `LLD/`, `workflows/default/WORKFLOW.md` | Filter SDK events, secure remote payloads, add regression coverage, and document the policy. |

## Data, migrations, and compatibility

- **Schema/data migration:** None. Existing rows remain stored; legacy tool/session rows are filtered from the Run console projection.
- **Backward compatibility:** Stable `RunEvent` types and existing Demo/live behavior remain available. Existing checkpoint queue and result-authoritative completion semantics are preserved.
- **Remote side effects:** This PR publishes no runtime data during CI. Once deployed, Live runs may publish concise checkpoints to their linked GitHub Issue; no automatic merge is introduced.

## Validation

List the commands actually run and their results. Do not write “will test” or claim checks that
were not observed.

- [x] `npm test` — result: 101 tests passed, 0 failed.
- [x] `npm run typecheck` — result: passed with no TypeScript diagnostics.
- [x] `npm run build` — result: production build passed; existing non-fatal Turbopack NFT tracing warning remains.
- [x] `git diff --check` — result: passed.
- [x] Other checks — result: focused Cline/checkpoint/GitHub/live-run/legacy-event filtering validation passed, 53 tests, 0 failures.

## UX evidence

Not applicable: this change preserves the existing Run console layout and updates the backend event/checkpoint
projection. The observable UX evidence is covered by focused event, checkpoint, and live-run tests.

## Security and secrets review

- [x] No `.env`, `.env.local`, tokens, API keys, authorization headers, or sensitive raw logs were added.
- [x] New inputs, outputs, logs, and remote requests follow existing redaction/security boundaries.
- [x] Any security limitation or follow-up is documented here and in the LLD: absolute workspace paths remain local-only; bounded summaries are intentionally visible to linked Issue reviewers.

## Risks, rollback, and follow-ups

- **Risks:** Over-filtering could hide a useful progress signal; forced host milestones and bounded completed summaries remain to mitigate this.
- **Rollback/recovery:** Revert this code-only change. No destructive database migration is required; preserved workspaces and existing rows remain available.
- **Known warnings:** Production build retains the existing non-fatal Turbopack NFT tracing warning.
- **Follow-up tasks:** Human review should confirm the balance between concise Issue comments and expanded local Run history. Issue #70 remains the parent context.

## Reviewer checklist

- [ ] The problem and acceptance criteria are clear.
- [ ] The implementation matches the linked LLD and stays within scope.
- [ ] Tests and validation results are real and sufficient.
- [ ] Error, interruption, rollback, and security behavior are addressed.
- [ ] Documentation and task status are ready for handoff.
- [ ] Human review is complete before merge.