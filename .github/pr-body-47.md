## Task and design references

- **Task:** Fixes #47 — https://github.com/maxlee98/project-agent-control-plane/issues/47
- **LLD:** `LLD/47-durable-run-leases-and-crash-recovery.md`
- **PR type:** Feature / migration / crash recovery

## Problem

Live run rows and task projections could remain queued/running after the owning server or worker
process exited. In-process Cline/session state correctly stopped counting as live, but there was no
durable owner fence, heartbeat, or truthful recovery outcome, leaving retries blocked by stale claims.

## Goals and non-goals

### Goals

- Persist Live owner identity, heartbeat, expiry, current stage, and interrupted recovery metadata.
- Renew healthy leases and fence updates from another owner or an expired lease.
- Recover expired Live runs at startup and through a bounded repository check without deleting workspaces.
- Repair the task projection and preserve deterministic retry/continue behavior after simulated restart.

### Non-goals

- Inferring completion from progress or missing in-process sessions.
- Deleting failed worktrees or run history.
- Multi-user authorization, hosted worker isolation, or replacing Cline/GitHub handoff semantics.

## Design and implementation

The additive `runs` migration adds `owner_id`, `lease_heartbeat_at`, `lease_expires_at`,
`current_stage`, `recovery_status`, and `recovery_reason`, with an index for bounded expiry scans.
Live claims receive a process-scoped owner and a conservative five-minute lease by default, renewed
on a timer and Cline activity/heartbeat callbacks. Stage and state writes require the owning process,
an active status, and an unexpired durable claim.

Expired Live runs are atomically changed to failed/interrupted with a fixed redacted diagnostic and
finish time; their task is moved to blocked/failed, a recovery event/activity is recorded, and the
claim is released. Recovery is idempotent and leaves the workspace path and run history intact. The
run API now returns the recovered run alongside events, and the console identifies interrupted runs.

## Changed files and boundaries

| Area | Files | Summary |
| --- | --- | --- |
| Domain/API | `src/lib/domain.ts`, `src/app/api/runs/[runId]/route.ts` | Add lease/recovery run fields and return run recovery state from the run endpoint. |
| Persistence | `src/lib/server/db.ts`, `src/lib/server/repository.ts` | Add additive schema migration, owner-fenced renewal/stage writes, bounded recovery, and terminal cleanup. |
| UI/UX | `src/components/ControlPlane.tsx` | Show interrupted status, current stage, and heartbeat recency without exposing secrets. |
| Tests/docs/config | `src/lib/server/cline.ts`, `src/lib/server/orchestrator.ts`, `tests/liveness.test.ts`, `tests/run-claims.test.ts`, `.env.example`, `LLD/47-durable-run-leases-and-crash-recovery.md` | Wire heartbeat hooks, startup/stage lease lifecycle, migration and crash/restart regressions, operator settings, and design record. |

## Data, migrations, and compatibility

- **Schema/data migration:** Additive nullable/defaulted `runs` columns and a lease index; existing run rows, claims, and workspaces are retained. Legacy active claims expire conservatively through the existing recovery boundary.
- **Backward compatibility:** Existing Demo/live lifecycle APIs remain compatible; old claim lease configuration remains accepted as a fallback. Continue/retry create a new normal claim after recovery.
- **Remote side effects:** None from implementation or tests. No provider, GitHub, branch, commit, push, or PR was invoked.

## Validation

List the commands actually run and their results. Do not write “will test” or claim checks that
were not observed.

- [x] `npm test` — result: passed, 96 tests, 0 failures.
- [x] `npm run typecheck` — result: passed with no TypeScript diagnostics.
- [x] `npm run build` — result: passed with the existing non-fatal Turbopack NFT filesystem-tracing warning documented in the LLD.
- [x] `git diff --check` — result: passed.
- [x] Other checks — result: focused `tests/run-claims.test.ts` passed, 4 tests; migration assertions passed in `tests/liveness.test.ts`.

## UX evidence

Not applicable: this is a local runtime/persistence change; the operator-visible evidence is the
Interrupted run console state and stage/heartbeat metadata rendered from the API projection.

## Security and secrets review

- [x] No `.env`, `.env.local`, tokens, API keys, authorization headers, or sensitive raw logs were added.
- [x] New inputs, outputs, logs, and remote requests follow existing redaction/security boundaries.
- [x] Any security limitation or follow-up is documented here and in the LLD.

## Risks, rollback, and follow-ups

- **Risks:** Clock/configuration issues could interrupt a healthy worker; the default lease is conservative, values below two minutes are rejected, and renewal is fenced by owner and expiry.
- **Rollback/recovery:** Revert the code while retaining additive columns and existing run/workspace history; no automatic workspace cleanup is introduced.
- **Known warnings:** Next/Turbopack reports the existing dynamic filesystem NFT tracing warning through `next.config.mjs` and workspace server code.
- **Follow-up tasks:** A future durable worker can call the exported bounded recovery operation; multi-worker policy/identity remains out of scope.

## Reviewer checklist

- [ ] The problem and acceptance criteria are clear.
- [ ] The implementation matches the linked LLD and stays within scope.
- [ ] Domain/source-of-truth boundaries are preserved.
- [ ] Tests and validation results are real and sufficient.
- [ ] Error, interruption, rollback, and security behavior are addressed.
- [ ] Documentation and task status are ready for handoff.
- [ ] Human review is complete before merge.