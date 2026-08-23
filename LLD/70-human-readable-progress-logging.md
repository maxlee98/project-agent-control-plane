# LLD: Human-Readable Agent Progress Logging

## Status

- **Status:** Implemented; ready for PR handoff
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-23
- **Related task or issue:** GitHub Issue #70 — [Refactor agent logs into human-readable progress updates](https://github.com/maxlee98/project-agent-control-plane/issues/70)
- **Related design:** [LLD #22 — Translate ClineCore events into run events](./22-translate-clinecore-events.md)

## Problem and observed evidence

The dashboard Event trace and GitHub Issue checkpoints currently receive too much low-value activity
from the Cline integration. The adapter translates generic status, usage, iteration, output-chunk,
tool-progress, and internal-update events into stable events, but many of those events do not help an
operator understand the run. The resulting trace reads like an SDK action log rather than a concise
progress record.

The useful human questions are different: Which lifecycle stage is active? What is the runner trying to
do? Which files or code boundaries are involved? Is the run waiting, validating, blocked, stopped, or
ready for review? Issue #22 already establishes the adapter boundary, redaction, bounded details, and
stable event vocabulary. Issue #70 should refine the retention and publication policy without exposing
the Cline vocabulary or changing the Issue #36 result-authoritative completion behavior.

## Goals

1. Make persisted local run events concise, stable, and understandable without Cline knowledge.
2. Make current activity and Issue checkpoints describe meaningful stage/intent/progress milestones.
3. Include safe, bounded file or code-area summaries when those facts are available from trusted
   control-plane operations, especially workspace, validation, and handoff boundaries.
4. Filter, aggregate, deduplicate, and rate-limit repetitive SDK activity.
5. Use the same human-readable progress projection for the event trace and Issue checkpoint content.
6. Preserve redaction, bounded output, checkpoint failure tolerance, Demo/live parity, and terminal
   semantics.

## Non-goals

- Do not expose Cline SDK event names or raw event payloads through the domain or UI.
- Do not persist prompts, reasoning, provider responses, raw tool input/output, credentials, session
  identifiers, or arbitrary command output.
- Do not publish every tool call, output chunk, usage update, or internal status to GitHub.
- Do not infer completion from an SDK `done`, `ended`, hook, or status event; `AgentResult` remains the
  authoritative live-run result.
- Do not change the database schema, worktree lifecycle, validation command execution, or final PR
  handoff unless a small compatibility change is necessary.
- Do not add a general-purpose observability system or a separate remote log sink.

## Requirements and acceptance criteria

- The event trace shows only useful stable milestones or concise progress summaries.
- A run's current activity identifies the stage and the runner's intent.
- Safe file/code-area summaries are bounded and redact secrets.
- Duplicate progress is suppressed and high-frequency progress is rate-limited per run.
- Workspace, validation, blocker, stop, handoff, and terminal events are retained and forced through the
  checkpoint boundary when existing policy requires them.
- GitHub checkpoints use concise human-readable progress and never become one-comment-per-SDK-event.
- Existing persisted rows remain readable and unsupported legacy values still normalize safely.
- Demo runs and live runs communicate comparable milestones.
- Focused tests cover selection, useful summaries, safe paths, redaction, deduplication/throttling,
  checkpoint formatting, and result-authoritative completion.

## Proposed design

### 1. Human-readable progress projection

Keep `RunEventType` as the closed control-plane contract. Add a small projection/policy boundary rather
than teaching the UI about Cline events. A progress candidate should carry only:

```text
type: stable RunEventType
message: concise operator-facing sentence
detail: optional redacted/bounded context
checkpoint: whether it is eligible for host checkpoint consideration
priority: milestone | progress | diagnostic (in-memory policy only)
dedupeKey: stable key for repeated progress (in-memory policy only)
```

The persisted shape need not gain all policy metadata. `priority` and `dedupeKey` may remain adapter or
orchestrator state used before `addRunEvent`. If metadata is added to a draft, it must not expand the
public SDK payload or database contract without a deliberate compatibility decision.

### 2. SDK event filtering at `cline.ts`

`translateClineEvent` remains defensive and scalar-only. Change its behavior from translating every
recognized event into a visible record to the following policy:

- Ignore usage, generic status, snapshots, raw chunks, and internal updates unless they provide a
  genuinely new safe human-facing fact.
- Convert meaningful notices and waiting-for-input signals into concise progress messages.
- Retain tool lifecycle only when it communicates a meaningful operation, with a safe tool name and no
  input/output payload. Repeated tool-progress updates should be omitted or coalesced.
- Treat text/content as a summary candidate only after bounded redaction and only when it adds intent or
  a useful result; do not mirror model output into the trace.
- Keep error and terminal observations available for local diagnostics, but do not let them determine
  success. The returned completion result remains authoritative.
- Return `null` for low-value events where omission is safer than a generic “update received” record.

The adapter should prefer explicit human language such as “Agent is inspecting repository structure”
or “Agent is waiting for input” over “Agent status updated”. It should not claim a file was changed
based only on an untrusted SDK field.

### 3. Host-owned milestones and file summaries

The orchestrator owns facts that Cline cannot reliably establish: isolated workspace creation/reuse,
validation start/results, changed files returned by the handoff, stage transitions, and checkpoint
failures. These events should be the primary source of file and lifecycle information.

Changed-file summaries should use trusted host-side `commitAndPush` output or another narrowly defined
allowlist. Paths are normalized, bounded in count and length, redacted, and rendered as names/areas—not
file contents or command output. If no safe path is available, use a code-area or stage summary rather
than guessing.

### 4. Deduplication and throttling

Introduce a small per-run progress gate at the orchestration/checkpoint boundary. It should:

1. Always pass forced milestones: workspace, validation result, blocker/failure, stop, handoff, and
   terminal transitions.
2. Drop an event whose stable dedupe key matches the latest visible event.
3. Rate-limit ordinary progress by a configurable interval, with a conservative default suitable for a
   long-running agent.
4. Retain the latest deferred progress candidate so a meaningful update is not lost when the interval
   expires or the run reaches a forced boundary.
5. Keep local event persistence and GitHub publication separate: local useful events may be retained,
   while Issue checkpoints remain explicitly throttled and formatted by `IssueCheckpointPublisher`.

The gate must be deterministic in tests via an injected clock. It must not delay failure or handoff
publication, and checkpoint publication failures must remain non-fatal as today.

### 5. Issue checkpoint formatting

`IssueCheckpointPublisher` should receive the latest human-readable checkpoint projection, not raw SDK
events. Formatting should show phase, status, progress where meaningful, current intent, safe changed
files/code areas when available, and an actionable blocker/next step. Duplicate checkpoint content is
not published. Existing forced started/workspace/validation/handoff/failed behavior remains intact.

### 6. UI behavior

Prefer backend filtering so `ControlPlane.tsx` can continue rendering the stable `RunEvent` contract.
Only make a UI change if needed to label the selected information clearly or hide an explicitly
diagnostic field. The UI must never render raw Cline payloads.

## Affected boundaries

- `src/lib/server/cline.ts`: filter SDK events and produce safe human-readable candidates.
- `src/lib/server/orchestrator.ts`: persist meaningful milestones, host-owned intent, and safe file
  summaries; integrate per-run dedupe/throttle state.
- `src/lib/server/issue-checkpoints.ts`: format and publish the same concise projection with duplicate
  suppression and forced terminal handling.
- `src/lib/domain.ts`: add only stable policy types/helpers if needed; retain closed event vocabulary.
- `src/lib/server/repository.ts`: preserve redaction and legacy normalization safeguards if event
  persistence changes.
- `src/components/ControlPlane.tsx`: potentially clarify presentation, but no SDK coupling.
- `tests/cline-events.test.ts`: noisy-event filtering, useful summaries, redaction, and bounds.
- `tests/live-run.test.ts`: lifecycle, host milestones, file summaries, and result authority.
- `tests/issue-checkpoints.test.ts` or equivalent: formatting, deduplication, throttling, forced events.
- `workflows/default/WORKFLOW.md` and `docs/`: document local trace versus Issue checkpoint policy.

## Data, compatibility, and security

No schema migration is expected. Existing event rows remain readable through `normalizeRunEventType`;
new reads must continue to redact and map unsupported values to `unknown`. New output is scalar-only,
redacted, length-bounded, and allowlisted. Session IDs, prompts, provider/model responses, credentials,
raw tool payloads, and arbitrary metadata must not enter event details or Issue comments.

The publication gate is observational. It must not mutate run completion state, turn SDK observations
into success, or make a failed GitHub comment write fail an otherwise valid run.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Useful progress is suppressed | Keep explicit stage/validation/blocker/handoff milestones forced and test representative streams. |
| The trace appears idle during a long task | Update current activity with the latest safe intent while rate-limiting persisted/checkpoint events. |
| File paths leak sensitive data | Use host-owned allowlisted paths, normalization, redaction, count/length bounds, and no contents. |
| Issue comments become noisy | Deduplicate and throttle at the publisher; preserve forced failures and handoff. |
| Translation changes terminal behavior | Keep completion resolution independent and assert `AgentResult` authority in tests. |
| Existing consumers depend on old event counts | Preserve event types and read compatibility; change only low-value emission policy. |

Rollback is a code revert. No destructive database or remote operation is required.

## Validation plan

1. Add focused translator tests proving low-value SDK events are omitted and useful intent/waiting/error
   milestones survive with safe bounded details.
2. Add deterministic progress-gate tests for duplicate keys, rate limits, deferred latest updates, and
   forced milestone bypasses.
3. Add checkpoint tests proving concise formatting, duplicate suppression, forced failure/handoff
   publication, and failure-tolerant queue behavior.
4. Extend live-run tests for host-owned stage/file summaries, Demo parity, and `AgentResult` authority.
5. Run focused tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` through
   `npm run safe:run`.
6. Inspect the final diff for secrets, raw payloads, generated files, and accidental schema/UI changes.

## Decision log

- 2026-08-23: Create Issue #70 because the existing Issue #22 translation boundary still emits too
  much low-value activity for operators even though it protects the public event vocabulary.
- 2026-08-23: Prefer host-owned workspace, validation, and handoff facts for file/code-area summaries;
  do not trust arbitrary SDK file fields until a narrow allowlist is defined.
- 2026-08-23: Keep local useful progress and remote Issue checkpoints as separate retention policies,
  sharing the same human-readable projection but not the same publication frequency.

## Completion checklist

- [x] Design reviewed against Issue #70
- [x] Human-readable projection and filtering implemented
- [x] Progress deduplication/throttling implemented
- [x] Issue checkpoint formatting/publication updated
- [x] Regression tests added
- [x] Documentation/workflow policy confirmed
- [x] Tests, typecheck, build, and diff checks passed
- [ ] PR created with `Fixes #70` after branch freshness verification

## Implementation notes

- Low-value Cline usage, iteration, status, team-progress, snapshots, raw chunks, session shutdown,
  unknown hooks, and unsupported envelopes are omitted at the adapter boundary.
- Human-facing tool lifecycle, notices, waiting-for-input signals, errors, and terminal observations
  remain stable and redacted; completion still comes from the returned `AgentResult`.
- Issue checkpoint publication now deduplicates identical rendered content while retaining the existing
  forced milestone and failure-tolerant queue behavior.

## Validation results

- Focused Cline, checkpoint, and live-run validation — passed, 22 tests, 0 failures.
- Full test suite — passed, 97 tests, 0 failures.
- Typecheck — passed; `tsc --noEmit` completed without diagnostics.
- Production build — passed; Next.js compiled, typechecked, and generated all application routes.
  The existing non-fatal Turbopack NFT tracing warning remains unrelated.
- `git diff --check` — passed.