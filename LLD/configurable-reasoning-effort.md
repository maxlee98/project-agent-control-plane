# LLD: Configurable Reasoning Effort Per Agent Run

## Status

- **Status:** In progress; implementation validated locally, PR handoff pending commit and review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** [Issue #35](https://github.com/maxlee98/project-agent-control-plane/issues/35) — “Allow configuring reasoning effort per agent run”.

## Problem and observed evidence

The control plane snapshots the provider and model from environment configuration when it creates a
run, but it has no per-run reasoning-effort setting. The installed Cline SDK supports
`CoreSessionConfig.reasoningEffort`, so an operator cannot trade off latency, quality, and token cost
for an individual task. Existing runs and databases must remain readable when no effort was selected.

## Goals

- Expose an unset/default choice and the reasoning-effort capabilities available for the selected
  provider/model.
- Validate effort values at the API and persistence boundaries without inventing unsupported values.
- Snapshot the effective explicitly selected effort immutably on each run and pass it to ClineCore only
  when configured.
- Show the setting beside provider/model in run history and the active run detail.
- Cover omitted/default, supported, unsupported, malformed, persistence, and exact Cline start-config
  behavior with focused tests.

## Non-goals

- Do not add provider billing APIs or change cost calculation.
- Do not reconfigure an already-running Cline session.
- Do not fabricate provider-specific effort choices when SDK capability metadata is unavailable.
- Do not persist credentials or raw provider metadata.

## Requirements and acceptance criteria

1. The task/run control surface offers `Default`/unset plus supported effort choices for the selected
   provider/model.
2. API and repository validation reject malformed or unsupported values and accept omitted values for
   backward compatibility.
3. A run stores its immutable reasoning-effort snapshot; omitted values remain `null`/unset.
4. Live Cline startup includes `config.reasoningEffort` only for an explicitly configured value.
5. Dashboard run detail/history displays the effective effort alongside provider/model.
6. Existing databases migrate additively and legacy runs map to unset effort.

## Existing architecture

- `src/lib/domain.ts` defines `AgentRun`, `Task`, and dashboard contracts.
- `src/lib/server/db.ts` owns SQLite schema creation, additive migration, and seed fixtures.
- `src/lib/server/repository.ts` maps rows and creates immutable run snapshots from environment
  provider/model values.
- `src/lib/server/orchestrator.ts` dispatches a run and passes task/run data to the Cline adapter.
- `src/lib/server/cline.ts` builds the SDK `ClineCore.start()` configuration and already keeps the API
  key host-side.
- `src/app/api/tasks/[taskId]/runs/route.ts` accepts run-control input.
- `src/components/ControlPlane.tsx` renders task controls, active run detail, and run history.

## Proposed design

Use a small SDK-independent domain type for the supported effort values exposed by the provider/model
capability query. Add a server capability adapter that asks the SDK for provider/model metadata and
normalizes only the supported effort strings; if metadata is unavailable, return no choices rather
than inventing them. The API accepts a requested effort only when it is in that normalized capability
set. The UI loads capabilities from a read-only endpoint and sends `null`/omits the field for Default.

Add nullable `reasoning_effort` to `runs` with an additive migration. `createRun` resolves the requested
value against the selected provider/model before insertion and stores the resulting snapshot. No
`updateRun` path will include this field, preventing post-start mutation. `AgentRun` exposes
`reasoningEffort: ReasoningEffort | null`.

The Cline adapter constructs its config without a reasoning field by default and adds the validated
snapshot only when non-null. Credentials remain exclusively in the existing `apiKey` config field and
are never returned by capability endpoints or persisted snapshots.

## Data and state transitions

1. UI selects provider/model from the existing environment-backed run configuration and requests
   capability choices.
2. UI submits `reasoningEffort` as an allowed value or `null` for Default.
3. Runs API validates mode and effort; repository resolves the capability and creates a queued row with
   the immutable nullable snapshot.
4. Orchestrator reads the run snapshot and forwards it to `runCline`.
5. Cline startup receives `config.reasoningEffort` only when the snapshot is configured.
6. Dashboard maps `NULL` and legacy missing columns to “Default”/“unset” and displays explicit values.

## Affected files and boundaries

- `LLD/configurable-reasoning-effort.md`: design and validation record.
- `src/lib/domain.ts`: effort type, run snapshot, capability response contract.
- `src/lib/server/db.ts`: additive runs-column migration.
- `src/lib/server/reasoning.ts` (or equivalent): SDK capability normalization and validation.
- `src/lib/server/repository.ts`: create/map immutable run snapshot.
- `src/lib/server/orchestrator.ts`, `src/lib/server/cline.ts`: pass snapshot to startup.
- `src/app/api/tasks/[taskId]/runs/route.ts` and capability route: request validation and choices.
- `src/components/ControlPlane.tsx`: selection and run detail/history presentation.
- focused tests for capability validation, persistence, and Cline startup config.

## Risks, edge cases, and rollback

- SDK capability shape may vary by version: isolate unsafe SDK reads in one adapter and fail closed to
  an empty choice list.
- Existing databases may lack the column: use `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL` and map
  missing/NULL to unset.
- A stale UI may submit a value after model/provider changes: revalidate against the server-selected
  capability and return 400/409 without creating a run.
- A provider may expose no reasoning capability: Default remains valid; explicit values are rejected.
- Rollback is additive: code can ignore the nullable column while retaining old rows.

## Validation plan

- Inspect the installed SDK declaration/runtime shape and keep the adapter narrow.
- Run focused reasoning/persistence and live Cline adapter tests.
- Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and the hard-stop verifier.
- Verify no credential or arbitrary SDK metadata crosses the API, DB, UI, or event boundaries.

## Decision log

- 2026-08-22: Store reasoning effort on the run, not the task, because the requirement is an immutable
  per-run snapshot and retries/continuations must remain reproducible.
- 2026-08-22: Use nullable persistence and an explicit Default UI state to preserve legacy runs and
  avoid silently choosing an effort when the provider/model has no capability metadata.
- 2026-08-22: Confirmed the installed SDK exposes `Llms.getModelsForProvider()` and model
  `reasoningOptions`; the adapter extracts only `effort` option values and ignores toggle/budget
  controls because this task persists the SDK's `reasoningEffort` string.

## Implementation and validation notes

- Added the nullable run snapshot, additive migration, SDK capability adapter, runs capability route,
  API validation, Cline startup forwarding, and dashboard selection/history display.
- `npm run typecheck`: passed after adding the reasoning UI and API imports.
- `npm test`: passed; 63 tests passed, 0 failed.
- Focused reasoning test: passed; 3 tests passed, 0 failed.
- `npm run build`: failed after compilation during Next.js static generation with the pre-existing
  Turbopack NFT tracing warning and a React `useContext` null error in `/_global-error`; TypeScript
  completed successfully in that build attempt.
- `git diff --check`: passed.
- `node scripts/verify-hard-stop.mjs`: passed.
- Dedicated Cline start-config coverage and repository snapshot integration coverage are now covered
  by the added live-run and task-cost tests.

## Open questions and assumptions

- The exact installed SDK capability discovery method and metadata shape must be confirmed before
  implementation; the adapter will support the installed version only and fail closed otherwise.
- Provider/model remain environment-selected for this task; the new setting is per run, not a general
  provider-management feature.
- Canonical GitHub Issue #35 was verified with `gh issue list` before handoff.

## Completion checklist

- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests and typecheck passed; production build has a pre-existing static-generation failure
- [x] Documentation updated
- [ ] Handoff and issue-linked PR verified