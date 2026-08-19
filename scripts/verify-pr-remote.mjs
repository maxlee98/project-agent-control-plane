#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { assertValidPrBody, readTemplate } from "./pr-template.mjs";

function credentialHelperToken() {
  const result = spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) return null;
  const passwordLine = result.stdout.split(String.fromCharCode(10)).find((line) => line.startsWith("password="));
  return passwordLine?.slice("password=".length) || null;
}

const number = process.argv.slice(2)[process.argv.slice(2).indexOf("--number") + 1];
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? credentialHelperToken();
if (!number || !token) {
  process.stderr.write("usage: verify-pr-remote --number <pr-number> with GitHub credentials available\n");
  process.exit(2);
}

const response = await fetch(`https://api.github.com/repos/maxlee98/project-agent-control-plane/pulls/${number}`, {
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
});
const pr = await response.json();
if (!response.ok) throw new Error(`GitHub API ${response.status}: ${pr.message ?? "request failed"}`);
assertValidPrBody(readTemplate(), pr.body ?? "");
process.stdout.write(`PR #${pr.number} template verified state=${pr.state} base=${pr.base?.ref} head=${pr.head?.ref} url=${pr.html_url}\n`);