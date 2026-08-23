# LLD: Make GitHub Projects Priority Mandatory for Managed Issues

## Status

- **Status:** Implemented; pending human review and merge
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-23
- **Related task or issue:** [Issue #65](https://github.com/maxlee98/project-agent-control-plane/issues/65)

## Problem

The dashboard has a four-level priority model, but GitHub Projects does not. The local task model
stores numeric priorities `1` through `4` and renders them as `P0` through `P3`; the configured GitHub
Project #3 has no Priority field. New Issues and existing Project items can therefore be missing the
priority needed for reliable triage.

## Goals

1. Add a Projects V2 single-select Priority field with exactly `P0`, `P1`, `P2`, and `P3` options.
2. Make priority mandatory at the control-plane boundary and synchronize it with every managed Project
   Issue.
3. Preserve known local priorities during repair and assign unknown existing items the default `P2`.
4. Include an explicit priority line in newly created Issue bodies and the shared Issue template.
5. Keep inbound changes, mutations, and backfills idempotent while preserving local execution history.

## Non-goals

- Do not add priorities outside P0–P3.
- Do not infer priority from labels, title, status, or arbitrary Issue text.
- Do not delete or recreate Issues or Project items.
- Do not change unrelated Project fields, status lifecycle, or Demo-mode GitHub behavior.

## Canonical mapping

The existing persisted numeric values remain backward compatible:

| Stored value | Project value | Dashboard label |
| --- | --- | --- |
| `1` | `P0` | `P0` |
| `2` | `P1` | `P1` |
| `3` | `P2` | `P2` |
| `4` | `P3` | `P3` |

The existing omitted-create default remains stored value `3`, which is `P2`. A Project item with no
priority and no known local task priority is repaired to `P2` and persisted locally. A known local task
priority is authoritative during backfill; a later explicit inbound Project priority update becomes the
new local value.

## Design

### Shared domain contract

Add a fixed priority vocabulary and conversion helpers at the domain boundary. API validation accepts
only integer values `1`–`4`; UI labels use the shared helper rather than independent arrays. This avoids
the current P1–P4 selector mismatch.

### Projects V2 adapter

Extend the existing paginated Project query to discover the `Priority` single-select field and its
options. Validate one usable field and one option for each canonical value. Missing, duplicate, or
unsupported options fail closed with a safe diagnostic. The adapter will expose the normalized priority
option ID/value on each Issue item.

Use `updateProjectV2ItemFieldValue` with the discovered field and option IDs. Skip the mutation when the
item already has the desired option. All newly created Issues are added to the Project and assigned both
their initial Status and Priority before success is reported. Existing item repairs use the same
duplicate-safe operation.

### Issue body and template

Dashboard/API Issue creation will render exactly one canonical `Priority: P0`–`Priority: P3` metadata
line while preserving the supplied description. The Markdown template will require authors to select
or state one of the four values. Existing Issue bodies are not rewritten as part of normal sync; the
Project field is the authoritative mandatory representation for existing items.

### Persistence and synchronization

Extend the Project item snapshot and repository upsert inputs with priority. Inbound Project values
update only task priority and remote metadata; run, branch, PR, agent-state, and summary history remain
unchanged. Missing values use P2, and sync responses add a repair counter. The sync route will ensure
local tasks and Project items are both assigned a valid value before reporting success.

### Remote Project migration

After code validation, inspect Project #3 again and create the Priority field with the four options only
if absent. Then run the existing explicit sync/backfill flow. Verify the Project field and every
repository Issue item afterward. Remote mutation is additive and does not delete content.

## Affected files

- `src/lib/domain.ts` — shared priority vocabulary and conversions.
- `src/lib/server/github.ts` — field discovery, validation, mutation, Issue body rendering, and item
  snapshots.
- `src/lib/server/repository.ts` — priority-aware upserts and local default/backfill behavior.
- `src/app/api/tasks/route.ts` and `src/app/api/tasks/[taskId]/route.ts` — mandatory priority and
  remote synchronization.
- `src/app/api/projects/[projectId]/sync/route.ts` — repair counters and inbound updates.
- `src/components/ControlPlane.tsx` — P0–P3 selector and sync feedback.
- `.github/ISSUE_TEMPLATE/task.md` — explicit priority requirement.
- `tests/` — adapter, repository/API, template, and history-preservation tests.

## Risks and rollback

Projects V2 field and option IDs are installation-specific, and mutations can be eventually consistent.
The adapter discovers IDs by name, validates the complete contract, skips already-correct values, and
uses bounded readback where needed. Invalid configuration fails closed rather than silently assigning a
wrong priority. Rollback reverts code and template changes; the additive Project field and assigned
values remain safe for manual cleanup or a later retry.

## Validation plan

- Run focused priority and GitHub adapter tests with mocked REST/GraphQL responses.
- Run repository/API and Issue-template tests, then the full test suite.
- Run typecheck, production build, and `git diff --check` through `safe-run`.
- Query Project #3 before and after the approved remote migration/backfill; verify all repository Issue
  items have exactly one P0–P3 option and rerun to confirm zero duplicate repairs.
- Review the final diff for secrets, unintended remote writes, and preservation of local task history.

## Acceptance criteria

- [x] Project #3 has the mandatory P0–P3 Priority field.
- [x] New live Issues and Project items receive matching priority.
- [x] Existing missing values are repaired to P2, with known local values preserved.
- [x] Inbound and dashboard priority changes are bidirectionally synchronized.
- [x] Invalid Project priority configuration fails safely.
- [x] Demo mode remains local-only.
- [x] Tests and repository validation pass.

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 96 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed with the existing Turbopack NFT tracing warning.
- `npm run safe:run -- --timeout-ms 30000 -- git diff --check` — passed.
- Project #3 field creation — verified `Priority` single-select with exactly P0, P1, P2, and P3 options.
- Live sync — completed with `count=31`, `imported=1`, `updated=30`, and `repairedPriorities=31` while assigning missing values.
- Idempotent replay — completed with `count=31`, `imported=0`, `updated=31`, `repairedPriorities=0`, `createdIssues=0`, and `addedProjectItems=0`.