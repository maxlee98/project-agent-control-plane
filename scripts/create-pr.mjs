#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { assertFreshComparison } from "./branch-freshness.mjs";
import { assertValidPrBody, readTemplate } from "./pr-template.mjs";
import { assertValidPrTitle } from "./pr-title.mjs";

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
const titleFile = argumentValue(args, "--title-file");
const title = titleFile ? fs.readFileSync(titleFile, "utf8").trim() : argumentValue(args, "--title");
const head = argumentValue(args, "--head");
const base = argumentValue(args, "--base");
const bodyFile = argumentValue(args, "--body-file");
const repository = process.env.GITHUB_REPOSITORY ?? "maxlee98/project-agent-control-plane";
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? credentialHelperToken();

if (!head || !base || !bodyFile) {
  process.stderr.write("usage: create-pr [--title <title> | --title-file <path>] --head <branch> --base <branch> --body-file <path>\n");
  process.exit(2);
}
if (title) assertValidPrTitle(title);
if (!token) {
  process.stderr.write("GitHub credential helper or GITHUB_TOKEN is unavailable; PR write was not attempted.\n");
  process.exit(2);
}

const body = fs.readFileSync(bodyFile, "utf8");
assertValidPrBody(readTemplate(), body);
const api = `https://api.github.com/repos/${repository}`;
const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };

async function github(pathname, init = {}) {
  const response = await fetch(`${api}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${result.message ?? "request failed"}`);
  return result;
}

const owner = repository.split("/")[0];
const freshnessBase = process.env.PR_FRESHNESS_BASE ?? "main";
const comparison = await github(`/compare/${encodeURIComponent(freshnessBase)}...${encodeURIComponent(head)}`);
assertFreshComparison(comparison, freshnessBase, head);
const existing = await github(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=10`);
if (Array.isArray(existing) && existing[0]) {
  const update = { body, base };
  if (title) update.title = title;
  const updated = await github(`/pulls/${existing[0].number}`, { method: "PATCH", body: JSON.stringify(update) });
  process.stdout.write(`updated PR #${updated.number} ${updated.html_url} state=${updated.state} base=${updated.base?.ref}\n`);
  process.exit(0);
}

if (!title) {
  process.stderr.write("--title is required when creating a new PR\n");
  process.exit(2);
}
const created = await github("/pulls", { method: "POST", body: JSON.stringify({ title, head, base, body }) });
process.stdout.write(`created PR #${created.number} ${created.html_url} state=${created.state} base=${created.base?.ref}\n`);