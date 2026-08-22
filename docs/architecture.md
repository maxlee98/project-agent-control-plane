# Architecture

## Runtime split

The web process is a control surface, not the agent process. A future daemon owns polling,
claims, retries, reconciliation, and long-running Cline sessions. This prevents a browser tab or
a Next.js request from becoming the lifecycle owner of work.

The demo run lifecycle lives in `src/lib/server/orchestrator.ts` so the vertical slice can be
explored without credentials. Live runs use the same orchestrator boundary and delegate to the
ClineCore runner, worktree manager, Git handoff, and GitHub adapter.

## Source-of-truth rules

| Concern | Source of truth |
| --- | --- |
| Issues, comments, labels, PRs | GitHub |
| Board status and custom fields | GitHub Projects V2 |
| Issue open/closed lifecycle | Derived from GitHub Projects V2 status (`Done` closes; other workflow states open) |
| Current process, workspace, retries | Local SQLite |
| Detailed agent event stream | Local SQLite, with retention |
| Human-readable checkpoints | Local activity + concise GitHub comment |

The GitHub adapter should normalize GraphQL/REST payloads at its boundary. GitHub node IDs,
project field IDs, and option IDs must not leak into orchestration rules.

Human workflow status changes in Live mode reconcile the GitHub Projects V2 item and linked issue
before updating the local projection. Sync reads Projects V2 status, repairs the derived issue
open/closed lifecycle, and then upserts SQLite. Missing project IDs, unsupported custom status
options, and remote mutation failures are surfaced instead of reported as successful syncs.
Every implementation PR must explicitly link its canonical GitHub Issue with `Fixes #<number>` or
`Closes #<number>`. The closing keyword creates the GitHub Development relationship and closes the
Issue on merge; the Issue is the sole task item on the Issue-only Project board, and PRs are linked
implementation artifacts rather than separate task items.
Every Issue-backed LLD uses the matching human-readable path
`LLD/<issue-number>-<task-slug>.md`; the Issue number is verified before the document is created.
Pre-policy LLDs without a verifiable Issue identity are retained only as documented legacy
exceptions.

## Integration seams

- `src/lib/integrations.ts` — `ProjectTracker` and `AgentRunner` contracts.
- `src/lib/server/repository.ts` — persistence and domain mapping.
- `src/lib/server/orchestrator.ts` — claims and run lifecycle for demo and live modes.
- `src/lib/server/workspaces.ts` — isolated worktrees, checks, commits, and pushes.
- `src/lib/server/cline.ts` — ClineCore session lifecycle and event translation.
- `src/lib/server/github.ts` — GitHub REST/Projects V2 integration.
- `workflows/default/WORKFLOW.md` — versioned agent behavior contract.

The Cline implementation should use `ClineCore`, subscribe to its session event envelope, translate
events into the stable run event vocabulary, and always dispose the session. High-volume agent
events stay in local run history; only host-owned lifecycle checkpoints are eligible for external
publication. GitHub writes should be performed by a host-side adapter rather than passing the raw
token into the child agent process.

## Live-run verification procedure

When validating a real Live run, keep credentials host-side and use bounded, separate checks:

1. Confirm `git status --short --branch`, `git worktree list --porcelain`, and the expected
   `origin/main` before starting. Do not print `.env.local` or process environments.
2. Start the app in the operator's terminal with `EXECUTION_MODE=live`; query readiness with
   `curl --connect-timeout 2 --max-time 5 --fail --silent --show-error
   http://127.0.0.1:3000/api/dashboard`. Require `runtime.executionMode` to be `live` and
   `runtime.liveReady` to be `true` before starting a task.
3. Start one Issue-linked task and poll its run API with a bounded `curl --max-time` request. Check
   that the run emits stage events for workspace, Cline, validation, Git, and PR boundaries, and
   that `isActive` is true only while the current process owns the Cline session.
4. For success, require persisted `status=completed`, `progress=100`, `commitSha`, changed files,
   passed checks, a verified PR URL, and task state `agent_review`. An Issue-comment failure after
   the PR must appear as a warning without changing those completed states.
5. For failure or operator stop, require the stage-specific redacted error, preserved workspace
   path, and truthful `failed`/`stopped` state. Query Git and GitHub before retrying any interrupted
   side effect.
6. Stop the app through the operator's terminal, verify no unexpected process/listener remains, and
   retain a concise checkpoint of the observed stage and outcome.

The network-free `tests/live-run.test.ts` suite provides the deterministic counterpart to this
procedure using injected adapters and temporary SQLite state; it never calls a provider or GitHub.

## Data migration path

SQLite is intentionally behind a small repository module. The hosted migration is:

1. PostgreSQL for durable entities.
2. A queue/Redis stream for orchestration events.
3. Object storage for long logs and artifacts.
4. Webhooks for GitHub changes, with polling retained as reconciliation.