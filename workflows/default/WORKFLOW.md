---
polling:
  interval_ms: 4500
  max_concurrent_agents: 2
agent:
  max_run_minutes: 45
  checkpoint_interval_minutes: 8
tracker:
  active_states: [ready, in_progress]
  handoff_state: human_review
---

# Project agent workflow

You are working on a task selected by the Project Agent Control Plane.

## Before changing code

1. Read this task, its recent human context, and the repository's README.
2. Inspect the relevant code paths before choosing an implementation.
3. Keep the change focused on the task. Do not rewrite unrelated modules.
4. Check for a repository-specific `WORKFLOW.md` and follow it over this default contract.
5. Inspect the current Git branch before the first edit. If it is `main`, create a task-scoped branch before changing files.

## Terminal hard stop

- Agent-authored terminal commands MUST run through `npm run safe:run -- --timeout-ms 120000 -- <direct-command> <args>`.
- MUST NOT use `cat >`, `cat >>`, `tee` multiline input, heredocs, shell `-c`/`-i`, nested shells,
  `eval`, Python stdin/REPL/`-c`, Node inline evaluation, unclosed quotes, or long inline chains.
- Multiline or quoted logic MUST be created with the editor/patch operation as an inspectable script,
  read back, and executed separately through the runner.
- `quote>`, `dquote>`, `heredoc>`, bare `>`, `>>>`, and `...` are emergency-stop signals: cancel,
  classify the command as unknown, inspect state, and never guess a delimiter.

## Compulsory pull-request template

- Every PR MUST use `.github/pull_request_template.md`; GitHub REST creation does not apply it automatically.
- Agents MUST create a patch-created body file, validate it with `scripts/verify-pr-template.mjs`,
  and create/update the PR only through `scripts/create-pr.mjs`.
- Agents MUST NOT send abbreviated ad-hoc PR bodies through REST, curl, or custom one-off payloads.
- After the remote write, query and verify the PR number, URL, state, base, head, and body contract.
- The CI template gate must pass before the task is moved to human review. Never merge automatically.

## Feature-branch freshness

- Before every PR create/update, verify `main...<feature>` with
  `scripts/verify-branch-freshness.mjs`; `behind=0` and non-diverged status are mandatory.
- If stale, use `scripts/update-branch-from-main.mjs --strategy update` to merge `origin/main`, or
  `--strategy rebase` to rebase onto `origin/main`, then verify again.
- Never force-push automatically after rebase; use an explicit, reviewed `--force-with-lease` push
  only on the feature branch.
- `scripts/create-pr.mjs` repeats the freshness gate and must refuse a stale head.

## Pull-request-first policy

- Every feature, bug fix, refactor, test, documentation, configuration, and migration change must be developed on a dedicated branch and delivered through a pull request.
- Never commit work directly on `main` and never push directly to `main`.
- Use `.github/pull_request_template.md` for every PR. Link the control-plane task and its `LLD/<task-slug>.md`.
- A PR must describe the problem, goals/non-goals, design, affected boundaries, migrations, validation results, security review, risks, and follow-ups.
- Before a remote write, verify local status, diff whitespace, commit SHA, branch, and relevant checks. Query remote state before retrying an interrupted push or PR operation.
- Local commits are not a completed handoff until the dedicated branch and PR are verified remotely.

## While working

- Work only inside the assigned isolated workspace.
- Prefer small, reviewable changes.
- Run the narrowest useful test after each meaningful change, then the configured project checks.
- Never put credentials, tokens, or full environment files into logs or comments.
- If a decision is ambiguous, leave a concise checkpoint and continue with the safest reversible interpretation.

## Handoff

When the work is ready:

1. Summarize the problem, approach, changed files, and checks run.
2. Call out anything that remains uncertain or needs human review.
3. Update the LLD with actual validation results and remaining warnings.
4. Create or update the dedicated branch and pull request using `.github/pull_request_template.md`.
5. Verify the remote branch and PR URL/status after the write.
6. Do not merge the pull request automatically; wait for explicit human approval.

The control plane owns the durable GitHub comment/checkpoint. Keep agent output concise enough to be useful to a human scanning the board.