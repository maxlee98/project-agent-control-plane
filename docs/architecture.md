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

## Integration seams

- `src/lib/integrations.ts` — `ProjectTracker` and `AgentRunner` contracts.
- `src/lib/server/repository.ts` — persistence and domain mapping.
- `src/lib/server/orchestrator.ts` — claims and run lifecycle for demo and live modes.
- `src/lib/server/workspaces.ts` — isolated worktrees, checks, commits, and pushes.
- `src/lib/server/cline.ts` — ClineCore session lifecycle and event translation.
- `src/lib/server/github.ts` — GitHub REST/Projects V2 integration.
- `workflows/default/WORKFLOW.md` — versioned agent behavior contract.

The Cline implementation should use `ClineCore`, subscribe to `agent_event` messages, translate
them into the stable run event vocabulary, and always dispose the session. GitHub writes should be
performed by a host-side adapter rather than passing the raw token into the child agent process.

## Data migration path

SQLite is intentionally behind a small repository module. The hosted migration is:

1. PostgreSQL for durable entities.
2. A queue/Redis stream for orchestration events.
3. Object storage for long logs and artifacts.
4. Webhooks for GitHub changes, with polling retained as reconciliation.