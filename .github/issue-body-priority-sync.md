## Summary

Make GitHub Projects priority a required, synchronized field for every repository Issue managed by the
control plane. The dashboard already uses the P0–P3 vocabulary, but the configured Project has no
Priority field and existing Issues can therefore be unprioritized.

## Context and evidence

The local task model stores priority as integers `1` through `4`, displayed in the dashboard as `P0`
through `P3`. New dashboard tasks currently default to the normal priority, but
`src/lib/server/github.ts` only reads and writes the Projects V2 Status field. A live inspection of
Project #3 (`PVT_kwHOA1cLdc4Bg2Pz`) found the standard Title, Status, Labels, and lifecycle fields but
no Priority field. Existing Project Issues therefore have no consistent priority value.

## Problem

Priority is available in the local dashboard but is not represented in GitHub Projects, so planning and
triage views cannot reliably group or filter Issues by urgency. The synchronization path also has no
contract for missing priority values and no way to repair existing Project items safely.

## Goals and non-goals

### Goals

- Add a GitHub Projects V2 single-select `Priority` field with exactly `P0`, `P1`, `P2`, and `P3`
  options to the configured Project.
- Treat priority as mandatory for all control-plane-managed Issues and Project items.
- Synchronize the dashboard's canonical priority values to the Project field on Issue creation, task
  mutation, and Project reconciliation.
- Preserve known local task priorities when repairing existing items; assign unknown existing items the
  documented default `P2` and make the repair visible in sync results.
- Make inbound Project priority changes update the local task without overwriting local run, branch,
  pull-request, or agent history.
- Add the priority requirement to the generic Issue template and API-created Issue body contract so
  newly created Issues carry an explicit `Priority: P0`–`Priority: P3` value as well as the Project
  field.
- Keep synchronization idempotent and fail closed when the Project Priority field is missing,
  malformed, or has ambiguous options.

### Non-goals

- Do not introduce priorities outside P0–P3 or change the dashboard's existing priority vocabulary.
- Do not infer priority from labels, Issue titles, status, or arbitrary body text when no canonical
  local value exists; use the explicit P2 backfill rule instead.
- Do not delete or recreate existing Issues or Project items during migration.
- Do not modify unrelated Project fields or import Project Pull Requests as dashboard tasks.
- Do not automatically merge pull requests or change the human-review workflow.

## Acceptance criteria

- [ ] The configured GitHub Project has a single-select `Priority` field with exactly P0, P1, P2, and
      P3 options, and the control plane records or discovers the field and option IDs safely.
- [ ] Dashboard-created live Issues include an explicit priority in their body and receive the matching
      Project Priority option before the create operation is reported successful.
- [ ] Dashboard task creation and mutation require a valid priority in the 1–4/P0–P3 range; omitted
      creation input resolves to the existing default P2 rather than leaving priority blank.
- [ ] Project synchronization assigns the matching field value to every managed item and reports how
      many missing values were repaired.
- [ ] Existing local tasks retain their known priority during backfill; existing Project Issues without
      a known local priority are assigned P2 and persisted locally.
- [ ] Inbound Project priority changes update the local task priority while preserving execution and
      handoff metadata.
- [ ] Missing, duplicate, or unsupported Priority fields/options produce a safe actionable sync error;
      no item is falsely reported as synchronized.
- [ ] Demo mode remains local-only and continues to expose P0–P3 without requiring GitHub access.
- [ ] Focused tests cover field discovery, option mapping, create/update synchronization, idempotent
      backfill, default P2 behavior, malformed Project configuration, body rendering, and preservation
      of local task history.

## Affected areas

- `src/lib/domain.ts`: canonical priority type, labels, and Project-sync data contracts.
- `src/lib/server/github.ts`: Projects V2 Priority field discovery, mutations, validation, and Issue
  body rendering.
- `src/lib/server/repository.ts`: priority-aware Project upserts and safe P2 backfill persistence.
- `src/app/api/tasks/route.ts` and `src/app/api/tasks/[taskId]/route.ts`: mandatory priority validation
  and remote synchronization.
- `src/app/api/projects/[projectId]/sync/route.ts`: priority repair counters and inbound updates.
- `.github/ISSUE_TEMPLATE/task.md`: explicit priority prompt.
- `src/components/ControlPlane.tsx`: consistent P0–P3 labels and sync feedback.
- `tests/`: GitHub adapter, API, repository, and template regression coverage.
- `LLD/`: issue-linked design and validation record.

## Validation

- Use mocked REST/GraphQL responses to test Project Priority field discovery and option mutations without
  exposing credentials or requiring a live provider.
- Use isolated SQLite fixtures to verify known priorities are preserved and missing priorities default
  to P2 exactly once.
- Verify new Issue bodies contain one explicit canonical `Priority: P0`–`Priority: P3` line.
- Run the focused tests, full test suite, typecheck, production build, and `git diff --check` through
  the repository safe runner.
- If the configured Project is migrated during implementation, query it afterward and verify every
  repository Issue item has a valid Priority option.

## Risks and rollback

Project field IDs and option IDs are installation-specific, and GitHub Projects V2 field mutations may
be eventually consistent. Discover IDs by field name, validate the complete option contract, use bounded
read-after-write verification, and report partial remote success honestly. The P2 backfill is a
deliberate data migration; preserve an audit count and do not delete any Issue or item. Rollback reverts
the adapter/API/template changes and leaves the additive Project field and assigned values intact for a
future retry or manual cleanup.

## Follow-up questions

None blocking. Future work may add configurable priority vocabularies for Projects that are not managed
by this control plane, but the initial contract is intentionally fixed to P0–P3.