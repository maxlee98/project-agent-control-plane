#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { assertFreshComparison } from "./branch-freshness.mjs";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function credentialHelperToken() {
  const result = spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) return null;
  const passwordLine = result.stdout.split(String.fromCharCode(10)).find((line) => line.startsWith("password="));
  return passwordLine?.slice("password=".length) || null;
}

const args = process.argv.slice(2);
const base = argumentValue(args, "--base") ?? "main";
const head = argumentValue(args, "--head");
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? credentialHelperToken();
if (!head || !token) {
  process.stderr.write("usage: verify-branch-freshness --base <branch> --head <branch> with GitHub credentials available\n");
  process.exit(2);
}

const response = await fetch(`https://api.github.com/repos/maxlee98/project-agent-control-plane/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
});
const comparison = await response.json();
if (!response.ok) throw new Error(`GitHub API ${response.status}: ${comparison.message ?? "request failed"}`);
assertFreshComparison(comparison, base, head);
process.stdout.write(`branch freshness verified base=${base} head=${head} status=${comparison.status} ahead=${comparison.ahead_by} behind=${comparison.behind_by}\n`);