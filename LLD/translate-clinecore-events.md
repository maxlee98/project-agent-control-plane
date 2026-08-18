# LLD: Translate ClineCore events into run events

## Status
- Status: Complete
- Owner: Project agent
- Date: 2026-08-18
- Related task or issue: Translate ClineCore events into run events

## Problem
`src/lib/server/cline.ts` currently forwards ClineCore `agent_event` type strings directly to
the run-event store. That couples the dashboard and persistence consumers to Cline's vocabulary,
and makes it easy for raw provider output to bypass the intended summary/checkpoint boundary.
The task context also asks for a versioned workflow contract that states which updates are worth a
GitHub checkpoint rather than publishing every tool or output event.

## Goals
- Define a stable control-plane run-event vocabulary independent of ClineCore event names.
- Translate ClineCore lifecycle, progress, tool, completion, and error events at the adapter
  boundary before callbacks reach orchestration or persistence.
- Keep detail and human-readable summaries redacted before they are stored or published.
- Make checkpoint-worthy events explicit and limited to meaningful lifecycle milestones, validation
  outcomes, failures, and final handoff; keep chunks/tool chatter local-only.
- Add focused tests for translation and redaction without starting a Cline session or contacting
  GitHub.

## Non-goals
- Replacing ClineCore, changing provider configuration, or changing watchdog behavior.
- Reworking the dashboard layout or SQLite schema.
- Publishing every translated run event to GitHub.
- Automatically merging PRs or changing GitHub's source-of-truth responsibilities.

## Requirements and acceptance criteria
- The dashboard-facing `RunEvent` type does not require Cline event names.
- Every supported Cline event maps to a stable run event with a stable message, optional redacted
  detail, and an explicit checkpoint disposition.
- Unknown Cline events are retained as a generic local event, never leaked as a new
  dashboard vocabulary value.
- Cline output summaries, errors, tool names, and chunks are redacted before callback/persistence;
  session identifiers are not included in human-readable summaries.
- GitHub checkpoint policy is documented in `workflows/default/WORKFLOW.md` and implemented at the
  orchestration boundary.
- Tests, typecheck, and build pass.

## Existing architecture
- `src/lib/server/cline.ts` owns the ClineCore session and currently emits raw event types through
  `ClineCallbacks`.
- `src/lib/server/orchestrator.ts` persists run events and selects local activity milestones;
  the final handoff comment is published through `src/lib/server/github.ts`.
- `src/lib/server/repository.ts` is the redaction/persistence boundary for local events.
- `src/lib/domain.ts` defines the dashboard-facing `RunEvent` projection.
- `workflows/default/WORKFLOW.md` is loaded into the agent prompt and is the versioned behavior
  contract.

## Proposed design
Introduce a pure translation function in the Cline adapter. It accepts the normalized shape of a
Cline subscription payload and returns a stable `RunEventDraft` containing:

| Stable type | Meaning | GitHub checkpoint |
| --- | --- | --- |
| `session_started` | Cline session accepted | No; local run state is sufficient |
| `progress` | Human-readable agent progress/notice | No |
| `tool_started` / `tool_finished` | Tool activity | No |
| `output_summary` | Redacted summary of completed agent output | No; include in the next checkpoint |
| `validation_started` / `validation_passed` / `validation_failed` | Repository checks | Yes for pass/failure summary |
| `run_completed` | Agent turn completed | Yes when it is the meaningful handoff milestone |
| `run_failed` | Agent or adapter failure | Yes, concise redacted failure |
| `run_stopped` | Operator stopped the run | Yes only when an operator-visible recovery decision is needed |
| `output_chunk` | Streaming output fragment | No |
| `unknown` | Unsupported Cline event retained for diagnostics | No |

The translator will use stable messages and sanitized detail, not raw Cline type values. The
adapter callback will carry the stable type and checkpoint disposition; the orchestrator will store
the event and publish only checkpoint-worthy summaries through the existing host-side GitHub
adapter. To avoid flooding GitHub, repeated progress/tool/chunk events remain in SQLite only, and
the workflow contract states that the control plane owns checkpoint formatting.

## Data and state transitions
1. ClineCore emits a subscription message.
2. `cline.ts` narrows the payload and calls the pure translator.
3. The translator redacts user/provider text and returns a stable event projection.
4. The adapter invokes the callback with that projection; no raw Cline event reaches the
   orchestrator.
5. The orchestrator persists the stable event and, only when the projection is checkpoint-worthy,
   publishes a concise redacted GitHub summary at the existing host-side boundary.
6. The normal run lifecycle continues to perform checks and final PR handoff; failures preserve the
   existing worktree and produce a failure checkpoint.

## Affected files and boundaries
- `src/lib/domain.ts`: stable run-event type and checkpoint metadata types.
- `src/lib/server/cline.ts`: pure Cline-to-run translation and callback integration.
- `src/lib/server/orchestrator.ts`: consume stable events and apply checkpoint policy.
- `src/lib/server/repository.ts`: retain redaction at persistence boundary (only minimal signature
  changes if needed).
- `workflows/default/WORKFLOW.md`: document checkpoint-worthy milestones and local-only chatter.
- `tests/cline-events.test.ts`: translator/checkpoint/redaction coverage.
- `LLD/translate-clinecore-events.md`: decisions and actual verification results.

## Risks, edge cases, and rollback
- Cline SDK payload fields can vary by event; use defensive unknown-payload narrowing and a generic
  local event for unsupported shapes.
- Do not reject a run because a nonessential event cannot be translated.
- Error objects and output chunks may contain credentials; redact both before callbacks and again at
  persistence/publishing boundaries.
- Avoid duplicate GitHub comments for repeated Cline completion/error events by keeping GitHub
  publication tied to the orchestrator's existing lifecycle milestones.
- Rollback is safe by reverting the adapter/orchestrator/docs/tests changes; the schema is unchanged.

## Validation plan
- Run the focused Cline event translation test.
- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Inspect `git diff --check` and review the final diff against this LLD.

## Verification results
- Focused translator test: passed (5 tests).
- Full test suite: passed (11 tests).
- `npm run typecheck`: passed.
- `NODE_ENV=production npm run build`: passed. Next reported the existing non-fatal NFT tracing
  warning through `next.config.mjs` and `src/lib/server/db.ts`.
- `git diff --check`: passed.
- `npm rebuild better-sqlite3 --build-from-source`: passed to make the local native test dependency
  available under the workspace's Node runtime.

## Decision log
- 2026-08-18: Keep detailed translated events local and make GitHub checkpoint publication an
  explicit policy rather than a side effect of every event.
- 2026-08-18: Use stable semantic event names (`progress`, `tool_started`, `output_summary`, etc.)
  instead of forwarding Cline's `agent_event` names.
- 2026-08-18: Preserve redaction in both the adapter and repository/GitHub boundaries as defense in
  depth.

## Open questions and assumptions
- The adapter preserves the declared SDK subscription/start API and treats event payloads
  defensively so minor SDK payload additions remain local `unknown` events.
- Existing final PR comments remain the handoff checkpoint; event-level GitHub updates will be
  limited to meaningful validation/failure/recovery summaries and must not duplicate the final PR
  comment.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] Documentation updated
- [ ] Handoff verified (control-plane PR creation remains outside this workspace)