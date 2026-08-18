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
- Prefer the editor/patch operation for file changes; do not use `cat > file`, `cat >> file`, or
  incomplete/interactively entered heredocs for agent-authored content.
- Never start an interactive `python`/`python3` REPL or use shell-fed Python such as
  `python3 - <<'PY'` when the editor/patch operation is available. Use a short non-interactive
  command or create a script with the editor/patch operation and run it separately.
- Treat `quote>`, `dquote>`, `heredoc>`, bare `>`, and Python `>>>`/`...` prompts as incomplete
  input. Interrupt first, inspect the expected file/process state, and do not blindly repeat the
  side effect.

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

## Stuck shell input recovery

If a terminal appears to stop at a quote, heredoc, or Python continuation prompt:

1. Cancel the current command with `Ctrl-C`; do not guess a closing quote or delimiter.
2. Classify the command as unknown until its effects are independently checked.
3. Inspect the target file, `git status`/`git diff --check`, and relevant processes in separate,
   bounded commands.
4. Resume from the last verified checkpoint using the patch/editor operation.

If multiline input is unavoidable, use one complete command with a quoted delimiter such as
`<<'EOF'`, place the exact delimiter alone on the final line, and verify that the command exits.