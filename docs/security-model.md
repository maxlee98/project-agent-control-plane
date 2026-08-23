# Security model

The MVP is a personal, local, high-trust tool. That does not mean it should be careless.

## Required guardrails

- Keep GitHub and model secrets in the host environment, never in `RunEvent` payloads.
- Redact token-like values before writing checkpoints or comments.
- Validate that every worktree path is inside the configured workspace root.
- Use sanitized, collision-resistant branch and workspace names.
- Enforce one active claim per task and a global/per-project concurrency cap.
- Configure the Live-run caps with `AGENT_MAX_CONCURRENT_RUNS` and
  `AGENT_MAX_CONCURRENT_RUNS_PER_PROJECT`; claims expire through the durable lease recovery path.
- Keep a stop-all control available to the operator.
- Preserve failed worktrees for inspection instead of deleting evidence.
- Apply idle and maximum-runtime timeouts to real agent sessions.
- Do not merge pull requests automatically in the MVP.

## Autonomy posture

Agents may edit files, run tests, create branches, push branches, and open pull requests. A PR is
the human checkpoint. Status changes and summaries should make the handoff explicit, and the
control plane should keep an append-only local record of the side effects it initiated.

When the tool is hosted, add GitHub App installation scoping, per-user authorization, remote
worker isolation, encrypted secrets, and audit-log retention before allowing multi-user access.