# LLD: SQLite Lease Index Migration Order

## Status

- Status: Implemented locally; pending pull request review
- Owner: Project Agent Control Plane
- Date: 2026-08-23
- Related task or issue: [Issue #72](https://github.com/maxlee98/project-agent-control-plane/issues/72)

## Problem and evidence

The database initializer in `src/lib/server/db.ts` creates indexes on the durable run lease columns
inside the initial schema batch. On a database created before durable leases, `CREATE TABLE IF NOT
EXISTS runs` preserves the old table without those columns. SQLite therefore fails while creating
`idx_runs_lease`, before the additive migration can add `lease_expires_at`, and route module
evaluation fails with `no such column: lease_expires_at`.

## Goals

- Run additive `runs` column migrations before creating indexes that reference them.
- Preserve existing rows and local database history without a destructive reset.
- Protect the startup path with a regression test using a pre-lease schema.

## Non-goals

- No API contract, lease policy, or repository behavior changes.
- No database reset, data deletion, or replacement migration system.
- No changes to unrelated working-tree files.

## Design and implementation

The initial schema batch retains only indexes whose columns are present in every supported legacy
schema. Lease-related indexes are created after the existing additive migration checks have added
all current columns to `runs` and `active_run_claims`. Fresh databases still receive the same
indexes; legacy databases are upgraded before index creation.

`tests/liveness.test.ts` creates a SQLite database containing the historical `runs` columns but no
durable lease fields, then imports the database module. Successful initialization and the existing
schema assertions prove that the migration completes and the lease columns are available.

## Affected boundaries

- `src/lib/server/db.ts` — persistence schema initialization and additive migration ordering.
- `tests/liveness.test.ts` — legacy SQLite startup regression coverage.

## Data, compatibility, and recovery

- Migration is additive and preserves existing records.
- No API or persisted state is removed.
- If initialization fails for an unrelated schema problem, the existing startup failure behavior is
  unchanged.
- Rollback can remove the index-ordering change while leaving additive columns in place; no data
  cleanup is required.

## Validation plan and results

- `npm test` — passed, 99 tests.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

## Security and operations

The change contains no credentials, new inputs, remote requests, or sensitive logging. It only
changes local SQLite initialization order and test fixtures.

## Decision log

- 2026-08-23: Create lease indexes after additive migrations rather than reset or rebuild legacy
  tables, minimizing risk and preserving local development data.

## Handoff

- [x] Implementation complete
- [x] Regression test added
- [x] Tests and typecheck passed
- [ ] Pull request reviewed and merged by a human