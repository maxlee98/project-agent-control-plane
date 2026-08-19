#!/usr/bin/env node

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const repository = "maxlee98/project-agent-control-plane";
const branch = "fix/terminal-hard-stop-enforcement";
const base = "fix/github-task-status-reconciliation";
const api = `https://api.github.com/repos/${repository}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token ?? ""}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

if (!token) {
  process.stderr.write("GITHUB_TOKEN or GH_TOKEN is not exported; PR creation was not attempted.\n");
  process.exit(2);
}

async function github(pathname, init = {}) {
  const response = await fetch(`${api}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body.message ?? "request failed"}`);
  return body;
}

const head = `maxlee98:${branch}`;
const existing = await github(`/pulls?state=open&head=${encodeURIComponent(head)}&per_page=10`);
if (Array.isArray(existing) && existing[0]) {
  process.stdout.write(`existing PR #${existing[0].number} ${existing[0].html_url} state=${existing[0].state} base=${existing[0].base?.ref}\n`);
  process.exit(0);
}

const body = [
  "## Summary",
  "- enforce a repository terminal hard stop for quote and heredoc continuation prompts",
  "- add a shell-false, stdin-isolated, bounded safe runner with rejection and timeout tests",
  "- harden global LLD, terminal, and scripted-edit skills plus local agent guidance",
  "",
  "## Incident addressed",
  "A long inline remote PR command reached a quote continuation prompt. The new policy requires patch-created script files and the safe runner for agent-authored commands.",
  "",
  "## Validation",
  "- npm run safe:run -- --timeout-ms 120000 -- npm test (15 passed)",
  "- npm run safe:run -- --timeout-ms 120000 -- npm run typecheck",
  "- npm run safe:run -- --timeout-ms 120000 -- npm run build (passes; existing non-fatal NFT tracing warning)",
  "- npm run safe:run -- --timeout-ms 120000 -- git diff --check",
  "",
  "## Review notes",
  "- Global skill readback verified for all three canonical files.",
  "- Installer rerun verified idempotent.",
  "- No merge performed; human approval is required.",
].join("\n");

const created = await github("/pulls", {
  method: "POST",
  body: JSON.stringify({ title: "fix: enforce terminal hard stop for agent commands", head: branch, base, body }),
});
process.stdout.write(`created PR #${created.number} ${created.html_url} state=${created.state} base=${created.base?.ref}\n`);