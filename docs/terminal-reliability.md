# Terminal reliability protocol

This project follows the global `terminal-reliability` skill in `~/.agents/skills/terminal-reliability/SKILL.md`.
For Live-mode operations, also follow `.agents/skills/control-plane-live-ops/SKILL.md`.
For model requests with repository context, also follow `.agents/skills/content-size-protection/SKILL.md`.

The repository also has an enforced hard-stop runner. Agent-authored development commands MUST use:

```text
npm run safe:run -- --timeout-ms 120000 -- <direct-command> <args>
```

The runner uses `shell: false`, ignores child stdin, rejects unsafe command shapes, caps output,
and terminates timed-out process groups.

The purpose is to keep agent work recoverable when a shell command, dev server, package install, or
remote GitHub request is interrupted.

## Model request size

Follow the `content-size-protection` skill before starting or continuing a Cline/LLM request. Measure
the complete assembled context—including system instructions, workflow text, task context, history,
tool definitions, and tool output—before submission. Prefer targeted excerpts and compact
checkpoints over full repository dumps, and remeasure after reduction or chunking. Treat the
OpenRouter `403 Request blocked by content filter: Request content exceeds maximum size for content
filtering` response as an oversized request: preserve state, reduce the payload, and retry at most
once with a newly measured request. Never log the prompt, raw tool output, `.env.local`, or secrets.

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
- **MUST** use the editor/patch operation for file changes; **MUST NOT** use `cat > file`, `cat >> file`,
  `tee` multiline input, or any heredoc for agent-authored content.
- **MUST** create a temporary inspectable `.py`, `.sh`, `.mjs`, or `.js` script for non-trivial
  multiline/quoted logic, read it back, and execute it through `scripts/safe-run.mjs`.
- **MUST NOT** use `bash -c`, `sh -c`, `zsh -c`, shell interactive flags, `eval`, nested shells,
  Python REPL/stdin/`-c`, Node inline evaluation, unclosed quotes, or long inline command chains.
- Treat `quote>`, `dquote>`, `heredoc>`, bare `>`, and Python `>>>`/`...` prompts as incomplete
  input. Interrupt first, classify the operation as unknown, inspect state, and do not type a guessed
  delimiter or repeat the side effect.

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

There is no heredoc exception for agent-authored work in this repository. Create the content with
the editor/patch operation as a script, read it back, and run it through the safe runner.