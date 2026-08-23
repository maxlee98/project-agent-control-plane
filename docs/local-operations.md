# Local SQLite operations

The control plane keeps local execution state in `DATA_DIR/control-plane.db` (default:
`.data/control-plane.db`). SQLite schema changes are applied by the ordered migration registry in
`src/lib/server/db.ts`.

## Before a migration

Normal startup handles this automatically:

1. It checks `schema_migrations` for the latest recorded version.
2. If work is pending on an existing database, it checkpoints the WAL and creates a new SQLite
   backup in `DATA_DIR/backups/`.
3. It applies each missing migration in order, recording a version only after that migration commits.
4. It keeps only the newest eight automatic migration backups.

The backup filename contains `before-migration`, a timestamp, and a random suffix. The application
logs neither database rows nor backup contents. A failed migration closes the database and reports
the migration version and the backup path so the database can be recovered without guessing its
schema state.

## Manual checkpoint

Stop the development or production server before copying a database. Then make a bounded filesystem
copy of the database:

```text
mkdir -p .data/backups
cp .data/control-plane.db .data/backups/control-plane.db.manual.sqlite
```

Do not copy a live WAL database as a manual backup. Use the automatic pre-migration backup, or stop
the app first as shown above. The backup is a recovery artifact and may contain local task and run
history; keep its permissions as restrictive as the database.

## Restore after a failed migration

1. Stop the app and preserve the failed database directory for inspection.
2. Choose a verified backup under `DATA_DIR/backups/`; do not edit `schema_migrations`.
3. Move the current database aside, copy the backup to the exact database path, and remove stale
   SQLite sidecars:

```text
mv .data/control-plane.db .data/control-plane.db.failed
cp .data/backups/control-plane.db.before-migration-<timestamp>-<suffix>.sqlite .data/control-plane.db
rm -f .data/control-plane.db-wal .data/control-plane.db-shm
```

4. Start the app and verify that it opens and reports the expected local tasks/runs. If the restored
   backup predates a migration, startup will create another backup and retry the ordered upgrade.

Never restore over an open database, delete the failed copy before verification, or treat a manually
edited version number as a rollback. A backup restore is the rollback mechanism.

## Retention policy

Startup runs best-effort, indexed cleanup with these defaults:

| Data | Default window | Removal rule |
| --- | ---: | --- |
| `run_events` | 90 days | Completed runs only, with no active claim, worktree, or review task |
| `activity` | 180 days | Rows not tied to active, failed, stopped, worktree-bearing, or review evidence |
| completed `runs` | 365 days | Only after old event/activity rows are gone and no worktree/review evidence remains |
| `remote_deliveries` | 180 days | Terminal delivery statuses only; pending deliveries remain |

Queued/running runs, active claims, failed/stopped runs, failed/running agent states, non-null worktree
paths, `in_progress` tasks, and `human_review` tasks are excluded. Retention does not archive raw
prompts, credentials, or unbounded tool output, and dashboard query limits do not trigger deletion.

Override the windows with positive `*_RETENTION_DAYS` environment variables. Invalid or non-positive
values use the defaults. Cleanup failures are retried at the next startup and do not make the local
application unbootable.