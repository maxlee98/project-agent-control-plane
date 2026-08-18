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

## While working

- Work only inside the assigned isolated workspace.
- Prefer small, reviewable changes.
- Run the narrowest useful test after each meaningful change, then the configured project checks.
- Never put credentials, tokens, or full environment files into logs or comments.
- If a decision is ambiguous, leave a concise checkpoint and continue with the safest reversible interpretation.

## Run-event and GitHub checkpoint contract

The dashboard consumes the control plane's stable run-event vocabulary, not ClineCore event names.
Agent/tool chatter and streaming output are retained locally for diagnostics and must not be copied
into GitHub comments. The control plane should publish a concise, redacted GitHub checkpoint only
for:

- validation passed or failed;
- a run failure, including the safe recovery/worktree-preservation summary;
- an operator stop when a recovery decision is needed; and
- the final pull-request handoff.

Session start, progress notices, tool start/finish, output summaries, output chunks, and unknown
agent updates are local run events only. Checkpoint text must contain the meaningful outcome, avoid
credentials and raw provider output, and never include session IDs or authorization data. The final
PR handoff remains the primary human review checkpoint; do not duplicate it with a second generic
completion comment.

## Handoff

When the work is ready:

1. Summarize the problem, approach, changed files, and checks run.
2. Call out anything that remains uncertain or needs human review.
3. Create or update a branch and pull request according to the harness policy.
4. Do not merge the pull request automatically.

The control plane owns the durable GitHub comment/checkpoint. Keep agent output concise enough to be useful to a human scanning the board.