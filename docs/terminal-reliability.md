# Terminal reliability protocol

This project follows the global `terminal-reliability` skill in `~/.agents/skills/terminal-reliability/SKILL.md`.
For Live-mode operations, also follow `.agents/skills/control-plane-live-ops/SKILL.md`.

The purpose is to keep agent work recoverable when a shell command, dev server, package install, or
remote GitHub request is interrupted.

## Rules for this repository

- Keep `npm run dev` in the operator's terminal when possible; use bounded HTTP checks separately.
- Use `curl --max-time` for all local/API checks.
- Do not combine server startup, polling, GitHub writes, and cleanup into one opaque command.
- Treat an interrupted PR/commit request as unknown until GitHub/Git is queried.
- Never print `.env.local`; it contains provider and GitHub credentials.
- Keep SQLite resets scoped to `.data/` and ask before deleting it.
- Verify branch, commit SHA, PR number/URL, and run status after side effects.
- Use run-scoped workspaces for starts/retries; only explicit continuation may reuse a recorded worktree.
- Treat missing agent output as unknown and recover by querying persisted state instead of rerunning blindly.

## Recovery commands

```bash
# Check the local app without hanging
curl --max-time 5 --fail http://127.0.0.1:3000/api/dashboard

# Inspect the server before killing it
lsof -nP -iTCP:3000 -sTCP:LISTEN
tail -n 80 /tmp/project-agent-control-plane.log

# Stop only the local app on port 3000
lsof -ti tcp:3000 | xargs kill
```

For GitHub writes, query first and retry only when the desired branch/PR is confirmed absent.