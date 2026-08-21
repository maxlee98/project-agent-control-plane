# LLD: GitHub Issue Agent Checkpoints

## Status
- Status: Implemented; pending review
- Owner: Project Agent Control Plane
- Date: 2026-08-21
- Related task or issue: https://github.com/maxlee98/project-agent-control-plane/issues/18

## Problem

Live runs currently persist run events and local activity, but the linked GitHub Issue is only updated
after a pull request is created. A human watching GitHub cannot tell whether an agent has started,
reached validation, is still making progress, or failed before handoff.

## Goals

1. Publish concise, human-readable checkpoints to the canonical Issue during a Live run.
2. Publish meaningful lifecycle checkpoints immediately and throttle ordinary progress updates so a
   long Cline session does not flood the Issue.
3. Preserve checkpoint order when GitHub requests overlap and make failures best-effort: a failed
   Issue comment must not turn an otherwise valid run into a failed handoff.
4. Keep Demo mode entirely local and preserve the existing local run/event history.

## Non-goals

- Do not add every Cline tool event or raw model output to GitHub.
- Do not change Projects V2 status ownership or introduce a new database table/schema.
- Do not post credentials, environment contents, or unredacted tool output.
- Do not make human context comments or final PR handoff comments behave differently.

## Requirements and acceptance criteria

- A Live run posts start, workspace, validation, successful handoff, and failure checkpoints when
  those phases occur.
- Ongoing progress is posted no more often than the configured checkpoint interval, defaulting to the
  workflow's eight-minute interval; the latest progress is used for a periodic heartbeat.
- Checkpoints are serialized per run, and a final checkpoint waits for prior checkpoint requests.
- GitHub comment failures are recorded in local run/activity history and do not prevent PR handoff or
  change the run's success/failure state.
- Demo runs make no GitHub requests.
- Checkpoint bodies contain only concise phase/status information and the local run identifier.

## Existing architecture and affected boundaries

- `src/lib/server/orchestrator.ts` owns Live run phases and Cline callbacks.
- `src/lib/server/github.ts` already exposes the REST Issue comment boundary.
- `src/lib/server/repository.ts` stores redacted run events and activity entries.
- `tests/` uses isolated Node tests and injected fetch/dependencies for integration seams.

## Proposed design

Add a small checkpoint publisher with an injectable comment function. It maintains a per-run queue,
last-publication timestamp, and latest status. Forced lifecycle checkpoints bypass the interval;
ordinary progress and a timer heartbeat use the interval. Every request is caught and reported through
callbacks, while the queue remains usable for later checkpoints.

The orchestrator creates one publisher for each Live run, updates its latest status from Cline
activity, starts the heartbeat after dispatch, and stops it in a `finally` block. Existing final PR
comment behavior is represented by the publisher so comments remain ordered. The publisher is not
created for Demo scheduling.

## Data and state transitions

```text
Live run -> checkpoint publisher -> serialized GitHub Issue comment
                         |                         |
                         +-> local run/activity <- success or redacted failure
```

Checkpoint failure is an observable warning only:

```text
GitHub comment failure -> local warning event/activity -> Live run continues
```

## Affected files and boundaries

- `src/lib/server/issue-checkpoints.ts`: throttled, ordered, best-effort publisher.
- `src/lib/server/orchestrator.ts`: lifecycle/progress integration and cleanup.
- `tests/issue-checkpoints.test.ts`: interval, queue, failure, and body regressions.
- `LLD/github-issue-agent-checkpoints.md`: durable design and validation record.

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| GitHub is unavailable during a checkpoint | Catch the error, record a warning, and continue the run. |
| Multiple Cline events arrive together | Queue requests and throttle non-forced progress. |
| Run fails while heartbeat is active | Stop the timer in `finally`, then publish one forced failure checkpoint. |
| Detail contains sensitive data | Use fixed phase text and existing redacted local history; do not forward raw Cline events. |
| Process exits before a best-effort request completes | Final handoff/failure awaits the queue; earlier checkpoints remain best-effort. |

Rollback is limited to reverting the new publisher, orchestrator integration, tests, and this LLD; no
database migration or remote data repair is required.

## Validation plan

1. Unit-test forced lifecycle publication, interval throttling, serialized ordering, and failures.
2. Run the complete test suite, typecheck, build, and whitespace validation separately.
3. Verify the issue's comments after the remote PR handoff.

## Decision log

- 2026-08-21: Confirmed Issue #18 is the canonical task identity and is currently open with no comments.
- 2026-08-21: Chose Issue comments rather than Projects V2 mutations for run checkpoints because the
  existing GitHub adapter already supports comments and Projects status remains the workflow source
  of truth.
- 2026-08-21: Chose best-effort queued comments so GitHub availability cannot invalidate repository
  work or PR creation.

## Open questions and assumptions

- The existing `checkpoint_interval_minutes: 8` workflow value is represented by a default eight-minute
  runtime interval; repository-specific workflow YAML is not currently parsed by the orchestrator.
- A future configuration surface may expose the interval explicitly through an environment variable.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests, typecheck, and build passed
- [x] Documentation updated
- [ ] Handoff verified

## Validation results

- `node --experimental-strip-types --experimental-loader ./tests/extensionless-loader.mjs --test tests/issue-checkpoints.test.ts` — passed, 3 tests.
- `npm test` — passed, 45 tests.
- `npm run typecheck` — passed.
- `env NODE_ENV=production npm run build` — passed. Next reported the existing non-fatal NFT tracing
  warning through `src/lib/server/db.ts`.
- `npm run build` without a production environment — failed during prerendering with the existing
  `useContext`/non-standard `NODE_ENV` environment issue; production-mode build is the repository's
  validation path and passed.
- `git diff --check` — passed.
- `npm install` — completed to restore the absent dependency tree; npm reported existing audit,
  deprecation, and Node-engine warnings. No lockfile change was produced.