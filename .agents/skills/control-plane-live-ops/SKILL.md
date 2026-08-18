# Control Plane Live Operations

Use this skill when operating `project-agent-control-plane` in Live mode or recovering an interrupted agent run.

## Non-negotiable rules

1. Treat a missing, interrupted, or timed-out terminal result as **unknown**.
2. Inspect process, filesystem, Git, database, and GitHub state before repeating a side effect.
3. Use one bounded command per terminal call. Do not combine server startup, polling, GitHub writes, and cleanup.
4. Never print `.env`, `.env.local`, process environments, tokens, authorization headers, or full agent output that may contain secrets.
5. Never reuse a failed or stale workspace for `start` or `retry`. Only `continue` may reuse a recorded workspace, and only after verifying that the worktree is still registered.
6. Query before remote writes and verify after them: branch, commit SHA, PR URL/number, and checks.
7. Preserve failed worktrees long enough to capture their status/diff, then remove them with a narrowly scoped, verified cleanup.

## Live run protocol

### Preflight

Confirm the local checkout is the expected repository and that the required source is tracked on the default branch:

```text
git status --short --branch
git worktree list --porcelain
git rev-parse --verify origin/main
git ls-tree -r --name-only origin/main -- src/lib
```

### Server

Prefer having the operator run `npm run dev` in their own terminal. Use bounded HTTP reads separately:

```text
curl --connect-timeout 2 --max-time 5 --fail --silent --show-error http://127.0.0.1:3000/api/dashboard
```

The dashboard must report `executionMode: "live"` and `liveReady: true` before a run is started.

### Interrupted command recovery

1. Check `ps`, `lsof`, and the saved log.
2. Query local/API state by ID.
3. Query GitHub branch/PR state if a remote write may have happened.
4. Only then retry an operation that is confirmed absent.

### Handoff

Do not call a run successful from agent text alone. Require persisted `completed`, `commitSha`, changed files, passed checks, and a verified PR URL.

## Design intent

The harness enforces these rules in code: run-scoped fresh workspaces, explicit continuation reuse, Cline startup/inactivity/max-duration watchdogs, and redaction at the persistence boundary. This document governs operator behavior; it is not a substitute for those runtime checks.