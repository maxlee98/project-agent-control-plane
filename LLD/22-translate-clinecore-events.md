# LLD: Translate ClineCore Events into Run Events

## Status

- **Status:** Complete; ready for PR handoff
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** GitHub Issue #22 — [Translate ClineCore events into run events](https://github.com/maxlee98/project-agent-control-plane/issues/22)
- **Supersedes:** The stale implementation attempt in PR #9, which predates the merged Issue #36 live-run lifecycle.

## Problem

`src/lib/server/cline.ts` currently forwards ClineCore event type strings through the callback and
the orchestrator persists those strings directly as `RunEvent.type`. This makes the dashboard and
SQLite history depend on the SDK's event vocabulary, allows future SDK event names to become an
implicit public API, and risks storing raw provider/tool output in local event details.

Issue #36 introduced the correct two-phase Cline lifecycle (`start()` establishes a session,
`send()` executes a turn, and the returned `AgentResult` owns terminal success). Issue #22 must now
add translation without regressing that lifecycle or inferring success from a translated `done`
event.

## Goals

1. Keep the dashboard-facing run-event vocabulary owned by the control plane rather than ClineCore.
2. Translate supported Cline session, content, tool, progress, terminal, hook, and stream events at
   the adapter boundary before they reach orchestration or persistence.
3. Preserve concise, redacted, bounded human-readable summaries and never serialize arbitrary event
   payloads, session IDs, provider credentials, or raw tool results.
4. Retain detailed translated events in local SQLite while keeping high-volume chunks/tool chatter
   out of GitHub checkpoint comments.
5. Normalize legacy or future persisted event names to a stable `unknown` projection instead of
   exposing arbitrary strings to the UI.
6. Preserve the existing live-run state machine, result-authoritative completion behavior, cost
   accounting, timeout/stop behavior, and final PR handoff.

## Non-goals

- Do not change ClineCore, provider APIs, the database schema, or the dashboard layout.
- Do not make the dashboard import Cline SDK types or render raw provider payloads.
- Do not publish every translated event to GitHub or duplicate the existing final handoff comment.
- Do not treat a `done`, `ended`, hook, or status event as authoritative completion; `AgentResult` and
  the existing fail-closed fallback remain the runtime authority from Issue #36.
- Do not redesign the Cline event vocabulary itself or add external observability infrastructure.

## Requirements and acceptance criteria

- The `RunEvent` projection uses a closed control-plane `RunEventType` union rather than `string`.
- The Cline callback passes a stable `RunEventDraft`; no raw Cline event type reaches the
  orchestrator.
- Supported event categories map to stable semantic types: session/progress, tool start/finish,
  output summary/chunk, run completion/failure, and safe unknown updates.
- The translator accepts defensive `unknown` input and never throws because an SDK event has an
  unexpected shape.
- Event details are string-only, redacted, and length-bounded. Tool outputs, arbitrary metadata,
  reasoning payloads, and session identifiers are not persisted as human-readable details.
- Unknown/future source event names produce a generic local `unknown` event and do not become the
  returned `RunEvent.type`.
- Existing lifecycle, stage, validation, handoff, stop, and checkpoint-publication failure events
  remain valid stable control-plane values.
- Demo-mode events use the same stable vocabulary.
- Tests prove translation, redaction, truncation, unknown-event behavior, session-ID exclusion, and
  compatibility with the Issue #36 two-phase Cline lifecycle.

## Stable event vocabulary

| Control-plane type | Meaning | GitHub policy |
| --- | --- | --- |
| `run_started`, `dispatch` | Run claimed and dispatched | Local only |
| `workspace_ready`, `workspace_created`, `workspace_reused` | Workspace boundary | Local only |
| `session_started` | Cline session established | Local only |
| `progress` | Stable human-readable agent progress/notice | Local only |
| `tool_started`, `tool_finished` | Tool lifecycle summary without raw input/output | Local only |
| `output_summary` | Bounded final text summary | Local only; may inform a later host checkpoint |
| `output_chunk` | Bounded streaming fragment | Local only |
| `validation_started`, `validation_passed`, `validation_failed` | Repository validation milestones | Existing host policy only |
| `run_completed`, `run_failed`, `run_stopped` | Agent/run terminal observations | Existing host policy only |
| `handoff_complete` | PR handoff persisted | Existing final handoff comment only |
| `stage_started`, `stage_failed` | Orchestrator boundary diagnostics | Local only |
| `handoff_comment_failed`, `issue_checkpoint_failed`, `checkpoint_publish_failed` | Non-fatal host-side publication warning | Local warning |
| `unknown` | Safe diagnostic for unsupported source data | Local only |

The `checkpoint` flag on an in-memory draft identifies meaningful milestones for orchestration
policy; it does not itself trigger a GitHub write. The existing host-side PR/Issue boundary remains
the only place allowed to publish a concise external handoff.

## Design

### Adapter translation boundary

`translateClineEvent(input: unknown)` will:

1. Narrow the event envelope and extract only known scalar fields.
2. Map `agent_event` content, iteration, notice, usage, done, and error variants; `chunk`; `ended`;
   `hook`; and other current session envelopes to stable semantic drafts.
3. Redact and truncate selected text/error fields before returning them.
4. Return a generic `unknown` draft for unsupported event kinds, or `null` only for a malformed
   non-event value that cannot safely be associated with a run.

`runCline` will subscribe and filter by the registered session ID before updating liveness or
calling the translator. It will emit a synthetic stable `session_started` event without putting the
session ID in event detail. Terminal resolution remains separate: the returned `AgentResult` is
authoritative, while matching-session terminal events are only the existing no-result fallback.

### Orchestration and persistence

The live orchestrator will persist drafts through `addRunEvent` and use only stable types. Activity
updates will use the draft's stable message/detail but will not create a second raw event. Existing
stage and handoff events will be included in the same closed vocabulary. Repository reads will map
old or unsupported rows to `unknown`, preserving compatibility without a migration.

### Redaction and retention

Only known safe fields are selected from SDK payloads. Text, notice messages, error messages, tool
names, and stream chunks pass through `redactSecrets` and a small character limit. Tool input,
output, reasoning, usage metadata, and arbitrary payload objects are not copied into `detail`.
Persistence and GitHub adapters retain their existing defense-in-depth redaction.

## Affected boundaries

- `src/lib/domain.ts`: closed stable run-event types and draft/checkpoint helpers.
- `src/lib/server/cline.ts`: pure defensive Cline-to-run translator and callback integration.
- `src/lib/server/orchestrator.ts`: stable draft persistence and stable demo events.
- `src/lib/server/repository.ts`: stable event mapping and legacy-value normalization.
- `tests/cline-events.test.ts`: translator and redaction regression coverage.
- `tests/live-run.test.ts`: existing lifecycle compatibility assertions, if callback shape changes
  require updates.
- `workflows/default/WORKFLOW.md`: explicit local-event versus external-checkpoint policy.
- `LLD/22-translate-clinecore-events.md`: verified decisions and validation results.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| SDK adds a new event kind | Defensive narrowing maps it to local `unknown`; it cannot expand the UI contract accidentally. |
| Provider output contains a credential | Redact at translation, repository, workspace, and GitHub boundaries; never copy arbitrary objects. |
| High-frequency events flood GitHub | Chunks, tools, progress, and translated terminal observations are local; host handoff remains explicit. |
| Translation changes terminal semantics | Keep terminal resolution independent from translation and retain `AgentResult.finishReason` authority. |
| Existing database has old event names | Normalize reads to `unknown` without destructive migration. |
| An event callback throws | Keep translation pure/defensive; persistence remains outside the SDK event listener's narrowing logic. |

## Validation plan

1. Run focused translator and live-run tests.
2. Run `npm test`, `npm run typecheck`, and `npm run build` through `safe:run`.
3. Run `git diff --check` and inspect the final diff against this LLD.
4. Verify no environment files, credentials, raw payloads, or generated artifacts changed.
5. Verify branch freshness, template-compliant PR creation with `Fixes #22`, and remote PR metadata.

## Decision log

- 2026-08-22: Reimplement on merged `main` rather than revive stale PR #9 because Issue #36
  changed Cline execution to a two-phase session/turn contract.
- 2026-08-22: Keep a closed control-plane event union and map unsupported persisted/source values to
  `unknown`; dashboard consumers must not depend on Cline event names.
- 2026-08-22: Treat translation as observational only. `AgentResult.finishReason` remains the
  terminal authority and translated events cannot create false completion.
- 2026-08-22: Keep high-volume event detail local and preserve the existing host-side final handoff
  comment rather than publishing one GitHub comment per tool/chunk.

## Validation results

- SDK contract readback: verified `@cline/core` `CoreSessionEvent` payloads for `chunk`,
  `agent_event`, `team_progress`, pending prompts, snapshots, `ended`, `hook`, and `status`; the
  adapter filters every event by the registered session ID before translation or liveness updates.
- Focused validation: `npm run safe:run -- --timeout-ms 120000 -- node --experimental-strip-types
  --experimental-loader ./tests/extensionless-loader.mjs --test tests/cline-events.test.ts
  tests/live-run.test.ts` — passed, 13 tests, 0 failures.
- Full tests: `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 55 tests, 0 failures.
- Typecheck: `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed; `tsc --noEmit`
  completed without diagnostics.
- Production build: `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed; Next.js
  compiled, typechecked, generated 5 static pages, and finalized route optimization. The existing
  non-fatal Turbopack NFT tracing warning through `next.config.mjs` and `src/lib/server/db.ts`
  remains unrelated.
- Whitespace: `npm run safe:run -- --timeout-ms 30000 -- git diff --check` — passed before final
  handoff inspection; it will be rerun after documentation updates.
- Security review: no environment files were read or modified; translator details are scalar-only,
  redacted, bounded, and exclude session IDs/raw payloads; unknown legacy rows are projected to a
  generic `unknown` event without source names.

## Completion checklist

- [x] Design reviewed
- [x] Stable event contract implemented
- [x] Cline translation and redaction implemented
- [x] Orchestration/demo integration implemented
- [x] Regression tests added
- [x] Tests, typecheck, build, and diff checks passed
- [x] PR #41 handoff verified