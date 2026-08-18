# Project Agent Control Plane

> A local-first control room for running coding agents across your repositories.

Project Agent Control Plane turns a collection of GitHub repositories into one observable
workspace. Each repository gets its own GitHub Projects kanban board, while this app owns the
local runtime state: worktrees, active agent sessions, checkpoints, retries, and run history.

The first vertical slice is intentionally useful before credentials are configured:

- Seeded local SQLite data gives the dashboard something real to explore.
- Create projects and tasks from the UI.
- Move tasks between workflow states.
- Start, continue, stop, and retry agent runs.
- Watch run activity update live through polling.
- Keep the GitHub and Cline integrations behind adapters so they can be enabled safely later.

The app starts in **Demo mode** by design. Demo runs are visibly labeled and never edit a
repository, create a branch, commit, push, or open a PR. Switch to Live mode only after the local
credentials and repository configuration below are ready.

## Product boundary

GitHub remains the durable source of truth for issues, discussion, project status, labels, and
pull requests. SQLite is the source of truth for local execution state. The harness should post
concise checkpoint summaries to GitHub rather than flooding issues with every tool event.

```text
Next.js control room
        |
        +--> SQLite (projects, tasks, runs, events)
        +--> GitHub adapter (Projects V2, Issues, PRs)
        +--> Orchestrator (claims, retries, reconciliation)
        +--> Workspace manager (isolated Git worktrees)
        +--> Cline adapter (ClineCore sessions + events)
```

## Requirements

- Node.js 22+
- Git
- A local GitHub CLI login (`gh auth login`) for the future GitHub adapter
- Cline configuration for real agent runs (optional while using demo mode)

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The local database is created at `.data/control-plane.db`. Delete `.data` to reset the seeded
demo state.

## Enable live runs

Live mode is opt-in and runs locally with the same dashboard:

```dotenv
EXECUTION_MODE=live
CLINE_API_KEY=your-cline-provider-key
CLINE_PROVIDER_ID=anthropic
CLINE_MODEL_ID=claude-sonnet-4-5
GITHUB_TOKEN=your-token-with-repo-and-project-permissions
WORKSPACE_ROOT=~/.project-agent-control-plane/workspaces
```

Restart the dev server after changing `.env.local`. The GitHub token is kept host-side and is not
passed into Cline. Add each repository through the UI with:

1. Its `owner/repository` name.
2. The absolute or `~/` local checkout path.
3. Its GitHub Projects V2 node ID (`PVT_…`) for live board sync.

In Live mode, **Run** performs this handoff:

1. Validate the checkout and create an isolated worktree/branch.
2. Start ClineCore in that worktree and persist translated events.
3. Detect and run project checks.
4. Commit and push only after successful execution/checks.
5. Create a real GitHub pull request and post a concise issue comment.
6. Move the task to `Agent review` only after the PR exists.

If a prerequisite, check, Git operation, or GitHub request fails, the task is blocked/failed with
the real error and no fake PR URL is generated. Failed worktrees are preserved for inspection.

## Scripts

```bash
npm run dev        # local development server
npm run build      # production build
npm run start      # start production build
npm run typecheck  # TypeScript validation
```

## Repository setup

Use the **Add repository** flow to register a checkout and its GitHub Projects V2 board. Each
managed repository can optionally contain a `WORKFLOW.md` with its own coding conventions,
validation commands, branch rules, and handoff expectations. A starter contract lives at
`workflows/default/WORKFLOW.md`.

## Pull-request-first development

Every repository update—features, bug fixes, refactors, tests, documentation, configuration, and
migrations—must be developed on a dedicated branch and delivered through a pull request. Do not
commit or push directly to `main`. Before the first edit, inspect the current branch and create a
task-scoped branch when needed.

Every PR must use `.github/pull_request_template.md`, link the control-plane task and its LLD, and
describe the problem, goals, design, affected boundaries, validation results, security review,
risks, and follow-ups. Verify local checks and remote branch/PR state before reporting handoff.
Merging remains a human decision; agents must not merge automatically.

## Current implementation status

### Working now

- Multi-project overview and project switcher
- Kanban board with seven workflow stages
- Task creation, task status changes, and human context notes
- Task detail rail with activity timeline
- Agent run controls and local run lifecycle simulation
- SQLite persistence and seeded demo state
- Clear seams for GitHub, Cline, workspaces, and orchestration

### Integration status

1. GitHub Projects V2 read sync, Issue creation/comments, and PR creation are wired for Live mode.
2. ClineCore event translation and isolated worktrees are wired for Live mode.
3. Automatic branch/commit/push/PR handoff is wired for Live mode.
4. Hosted webhook reconciliation, richer Projects V2 status writes, and multi-user auth remain later hardening work.

See `docs/architecture.md` and `docs/security-model.md` for the implementation contract.
