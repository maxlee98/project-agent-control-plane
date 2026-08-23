# LLD: Versioned SQLite Migrations, Backups, and Event Retention

## Status

- Status: Complete locally; pending pull request review
- Owner: Project Agent Control Plane
- Date: 2026-08-24
- Related task or issue: [Issue #52](https://github.com/maxlee98/project-agent-control-plane/issues/52)

## Problem and observed evidence

`src/lib/server/db.ts` currently creates the schema and applies additive column checks during module
initialization, but it does not record a schema version or expose the order and outcome of upgrades.
`run_events` and `activity` are append-only, so a long-running local installation can grow without
bound even though dashboard reads are limited. A failed startup change also has no documented,
bounded backup/restore procedure.

## Goals

- Store an ordered schema version and apply idempotent migrations exactly once per database version.
- Preserve representative legacy data while upgrading, including tasks, runs, events, activity, and
  project links.
- Create a recoverable SQLite backup before migrations and document a safe restore/checkpoint flow.
- Bound event/activity growth conservatively without deleting active-run evidence or unreviewed work.
- Add indexes needed by retention and history queries and test migration, retry, retention, and backup
  behavior without printing database contents.

## Non-goals

- Replacing SQLite with PostgreSQL or introducing an external archive service.
- Automatically deleting active, failed, or unreviewed worktree evidence.
- Removing history solely because the dashboard uses a limit.
- Storing raw prompts, credentials, or unbounded tool output.

## Requirements and acceptance criteria

- [x] A schema version is stored and migrations run deterministically and idempotently.
- [x] Migration failures are explicit and leave a recoverable backup path.
- [x] Existing schemas upgrade without losing linked local history.
- [x] Event/activity retention policy is documented and implemented.
- [x] Cleanup excludes active runs and preserves handoff/recovery evidence.
- [x] Tests cover ordering, retry after partial failure, backup guidance, retention boundaries, and indexes.

## Existing architecture and affected boundaries

- `src/lib/server/db.ts` owns the process-local `better-sqlite3` database lifecycle, seed data, and
  startup reconciliation.
- `src/lib/server/repository.ts` owns history writes and bounded dashboard reads.
- `src/lib/domain.ts` exposes stable run and activity types; no public archive state is needed for the
  first conservative policy.
- `tests/liveness.test.ts` already exercises a pre-lease legacy schema and is the natural migration
  fixture boundary.
- `docs/architecture.md`, `docs/security-model.md`, and local operations guidance document source of
  truth, recovery, and retention rules.

## Proposed design

Use a `schema_migrations` table with a positive integer primary key, migration name, and applied time.
The runner creates only the migration metadata table first, discovers the highest applied version,
then executes a fixed in-code migration list in ascending order. Each migration is wrapped in one
SQLite transaction and records its version only after its schema/data work succeeds. Fresh and legacy
databases converge on the same latest schema. The migration list is exported for focused tests.

The first migration is the historical base schema, expressed with `CREATE TABLE IF NOT EXISTS` and
stable indexes. The second migration performs the existing additive columns and indexes in dependency
order, including lease columns before lease indexes. A later migration adds retention metadata and
history indexes. The runner creates a backup using SQLite's checkpoint/backup API before applying any
pending migration; backup failures abort startup. Backup files stay under `DATA_DIR/backups`, use a
timestamped bounded filename, and are never logged with database contents.

Retention defaults are conservative and configurable with positive day values: run events 90 days,
activity 180 days, completed runs 365 days, and remote delivery metadata 180 days. The cleanup runs
after successful initialization and is bounded per table. It removes only old low-risk rows: events
for terminal runs, old activity not associated with an active run, completed runs only when their task
is not `in_progress`/`human_review` and no retained event/activity references the run, and delivery
metadata only after its delivery status is terminal. Failed/stopped runs, unreviewed task evidence,
workspaces, and all active-run rows are preserved. Cleanup is best-effort after startup and never
prevents the app from booting.

## Data and state transitions

```text
open SQLite -> ensure schema_migrations -> backup if pending -> apply v1..latest
  -> run seed/reconciliation -> best-effort retention cleanup -> export db

pending migration failure -> close database -> restore documented backup -> fix/retry
active run or human_review task -> retain run/event/activity evidence regardless of age
terminal old low-risk history -> delete only rows past policy boundary
```

## Affected files and modules

- `src/lib/server/db.ts`: migration registry/runner, backup creation, retention settings, cleanup,
  and schema indexes.
- `src/lib/server/repository.ts`: retention-safe history queries and cleanup metadata if needed.
- `tests/liveness.test.ts` and a focused migration test fixture: legacy upgrade, ordering, retry,
  backup, indexes, and retention boundaries.
- `docs/architecture.md`: local database migration and retention operational contract.
- `docs/security-model.md`: backup permissions, sensitive local data, and recovery constraints.
- `README.md` or local operations documentation: checkpoint/restore commands and retention defaults.
- This LLD: decisions and actual validation results.

## Risks, edge cases, and rollback or recovery

- A migration can fail after changing schema objects; SQLite transactions roll back the migration and
  leave the prior recorded version. The pre-migration backup is the authoritative rollback path.
- A backup must not overwrite an existing file or print SQL/data. Permission and disk failures abort
  pending migrations clearly.
- Retention must not infer safety from dashboard limits. Active claims, non-terminal runs, failed or
  stopped runs, `human_review` tasks, and worktree-bearing rows are excluded.
- Concurrent module initialization uses the existing SQLite busy timeout and each runner observes the
  recorded migration rows after waiting.
- Rollback is restoring a verified backup file, not manually editing `schema_migrations` or guessing
  a downgrade.

## Validation plan

1. Add isolated temporary-database fixtures for fresh, legacy, ordered, partial-failure/retry, and
   retention-boundary cases.
2. Assert migration metadata, data preservation, indexes, backup file existence, and no sensitive
   output from guidance/scripts.
3. Run focused migration tests, then the full test suite, typecheck, production build, and whitespace
   validation.

## Decision log

- 2026-08-24: Verified canonical Issue #52 before creating this LLD.
- 2026-08-24: Prefer a small in-code ordered runner over a third-party migration dependency to keep
  startup behavior auditable and compatible with the current local-first repository.
- 2026-08-24: Choose conservative delete-only retention rather than automatic file archival; failed,
  stopped, and human-review evidence is more valuable than aggressive size control in this MVP.

## Open questions and assumptions

- The requested issue does not prescribe exact windows; 90/180/365/180 days are defaults and remain
  operator-configurable through environment variables.
- Remote delivery metadata did not previously exist, so migration 3 adds a small terminal/pending
  delivery table for future host-side publication retries without changing current remote behavior.
- Backup retention is bounded by count and age; backups are local recovery artifacts, not an archive
  substitute for the future hosted storage migration.

## Completion checklist

- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] Documentation updated
- [x] Handoff verified

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/sqlite-migrations.test.ts tests/liveness.test.ts` — passed, 8 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 112 tests.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed.
- `npm run safe:run -- --timeout-ms 120000 -- env NODE_ENV=production DATA_DIR=/tmp/control-plane-build-52 npm run build` — passed. Next emitted the existing non-fatal NFT tracing warning for dynamic filesystem access.
- `npm run safe:run -- --timeout-ms 30000 -- git diff --check` — passed.
- `npm install` — restored the absent dependency tree; npm reported existing audit and Node-engine warnings. No lockfile change was produced.

Remaining handoff work is branch freshness verification, commit/remote PR creation through the required
template flow, and remote PR metadata verification. No automated merge is performed.

## Handoff results

- Implementation commit: `e084dbe4795f07f8dbf73fb610099c8eadf96e20`.
- Feature branch: `agent/52-Task-Introduce-versioned-SQLite-mi-4cefe575`, pushed to `origin`.
- Freshness: `main...agent/52-Task-Introduce-versioned-SQLite-mi-4cefe575` verified `ahead=1`, `behind=0` before PR creation.
- Pull request: [#80](https://github.com/maxlee98/project-agent-control-plane/pull/80), open, base `main`, expected feature head, title `feat: introduce versioned SQLite migrations and retention`.
- PR body: validated with `scripts/verify-pr-template.mjs` and created through `scripts/create-pr.mjs`.
- No merge was attempted; human review remains required.
