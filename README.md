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
- A local GitHub CLI login (`gh auth login`) for GitHub repository operations and diagnostics
- Cline configuration for real agent runs (optional while using demo mode)

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The local database is created at `.data/control-plane.db`. Delete `.data` to reset the seeded
demo state. SQLite migrations are versioned and create a bounded pre-migration backup under
`.data/backups/`; see [local operations](docs/local-operations.md) before changing or restoring
the database.

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
6. Move the task to `Review` only after the PR exists, ready for a human decision.

If a prerequisite, check, Git operation, or GitHub request fails, the task is blocked/failed with
the real error and no fake PR URL is generated. Failed worktrees are preserved for inspection.

## Scripts

```bash
npm run dev        # local development server
npm run safe:run   # bounded, stdin-isolated command runner for agent operations
npm run safe:run -- --timeout-ms 30000 -- node scripts/verify-branch-freshness.mjs --base main --head feature-branch
npm run safe:run -- --timeout-ms 120000 -- node scripts/update-branch-from-main.mjs --strategy update
npm run safe:run -- --timeout-ms 120000 -- node scripts/install-content-size-protection.mjs # install the global request-size skill
npm run build      # production build
npm run start      # start production build
npm run typecheck  # TypeScript validation
```

Local SQLite migrations, backup/checkpoint, restore, and conservative history-retention rules are
documented in [docs/local-operations.md](docs/local-operations.md). The retention defaults can be
overridden with the `*_RETENTION_DAYS` variables in `.env.local`.

## Repository setup and onboarding

Use the **Add repository** flow to register a checkout and, for Live mode, its GitHub Projects V2
board. The detailed, copyable procedure is in the [repository onboarding checklist](docs/repository-onboarding.md).

The current flow records these values in local SQLite and can optionally run a read-only readiness
check. Registration and readiness do not clone, install dependencies, create a run worktree, or
silently modify the target checkout:

1. GitHub `owner/repository` name.
2. Absolute or `~/` local checkout path.
3. Projects V2 node ID (`PVT_…`), optional in Demo and required for Live synchronization.
4. Optional repository description.
5. **Check readiness now**, enabled by default in the Add repository dialog.

Before using Live mode, run or re-run the **Repository readiness** check and resolve every Live-required
blocker or unknown result. The dashboard reports the readiness level, contract version, timestamp,
category counts, remediation, and canonical Projects V2 status/priority mappings. Live task status
changes, sync, starts, retries, and continuations recheck readiness and return `READINESS_BLOCKED`
when the repository is not ready. Demo mode remains available without GitHub or Cline credentials and
never edits the target repository.

The control plane uses a repository-local `WORKFLOW.md` when present and otherwise falls back to the
starter contract at [`workflows/default/WORKFLOW.md`](workflows/default/WORKFLOW.md). It does not
silently copy this repository's `AGENTS.md` or `.agents/skills/` into a managed repository. If a target
repository needs a missing `WORKFLOW.md` or pull-request template, the readiness card can propose an
explicit **Create baseline via PR** action. That action adds only missing baseline files on a dedicated
target-repository branch and opens a pull request for human review; it never merges automatically.

## Documentation index

Start with the [repository onboarding checklist](docs/repository-onboarding.md), then use the
reference that matches the question:

| Reference | Use it for |
| --- | --- |
| [Architecture](docs/architecture.md) | Runtime ownership, source-of-truth rules, integration seams, Live-run verification, and migration direction. |
| [API contract](docs/api-contract.md) | Request limits, error shape, idempotency, follow-up workflow, and client recovery. |
| [Security model](docs/security-model.md) | Host-side secrets, worktree boundaries, autonomy posture, backups, retention, and preserved evidence. |
| [Local SQLite operations](docs/local-operations.md) | Migration backups, checkpointing, restore, and retention procedures. |
| [Terminal reliability protocol](docs/terminal-reliability.md) | Safe-runner requirements, bounded commands, interruption recovery, and unknown remote state. |
| [Default agent workflow](workflows/default/WORKFLOW.md) | Effective agent policy, branch/PR-first development, checkpoints, Live handoff, and Issue linkage. |
| [Environment example](.env.example) | Local defaults, Live credentials, capacity, lease recovery, and retention variables. |
| [Pull-request template](.github/pull_request_template.md) | Required task/LLD context, design, validation, security review, risks, and reviewer handoff. |
| [Issue template](.github/ISSUE_TEMPLATE/task.md) | Required structure for new Issue-backed tasks and acceptance criteria. |
| [LLDs](LLD/) | Durable designs, decisions, risks, and validation records for Issue-backed work. |

The [repository-onboarding documentation Issue](https://github.com/maxlee98/project-agent-control-plane/issues/81)
tracks this documentation work. The available readiness implementation is covered by the checklist;
future improvements should be tracked separately from the current onboarding contract.

## Pull-request-first development

Every repository update—features, bug fixes, refactors, tests, documentation, configuration, and
migrations—must be developed on a dedicated branch and delivered through a pull request. Do not
commit or push directly to `main`. Before the first edit, inspect the current branch and create a
task-scoped branch when needed.

Every Issue-backed design must use the human-readable filename pattern
`LLD/<issue-number>-<task-slug>.md`, with a verified positive GitHub Issue number and lowercase
kebab-case task slug. Historical LLDs without a verifiable Issue identity are preserved only as
documented legacy exceptions; do not substitute a PR number or local task ID.

Every PR must use `.github/pull_request_template.md`, link the control-plane task and its LLD, and
describe the problem, goals, design, affected boundaries, validation results, security review,
risks, and follow-ups. Verify local checks and remote branch/PR state before reporting handoff.
Every PR must also explicitly link one canonical GitHub Issue with `Fixes #123` or `Closes #123`.
Every PR title must use a Conventional Commit-style prefix: `feat`, `fix`, `docs`, `refactor`, `test`,
`chore`, `perf`, `build`, `ci`, or `revert`, followed by a colon and description (for example,
`feat: add task filtering`).
The closing keyword creates the GitHub Development relationship and closes the Issue when the PR is
merged, allowing the existing Issue-only Projects board item to move to Done. The PR is linked
implementation work and is not added as a second board item.
Merging remains a human decision; agents must not merge automatically.

## Current implementation status

### Working now

- Multi-project overview and project switcher
- Kanban board with six workflow stages
- Task creation, task status changes, and human context notes
- Task detail rail with activity timeline
- Agent run controls and local run lifecycle simulation
- SQLite persistence and seeded demo state
- Clear seams for GitHub, Cline, workspaces, and orchestration

### Integration status

1. GitHub Projects V2 read sync, Issue creation/comments, and PR creation are wired for Live mode.
2. ClineCore event translation and isolated worktrees are wired for Live mode.
3. Automatic branch/commit/push/PR handoff is wired for Live mode.
4. Repository readiness inspection, Live preflight gates, and explicit baseline pull-request preparation are wired for Live mode.
5. Hosted webhook reconciliation, richer Projects V2 status writes, and multi-user auth remain later hardening work.

See `docs/architecture.md` and `docs/security-model.md` for the implementation contract.
