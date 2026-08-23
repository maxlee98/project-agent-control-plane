import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Project } from "../src/lib/domain.ts";

const execFile = promisify(execFileCallback);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-readiness-"));
const previous = new Map<string, string | undefined>([["DATA_DIR", process.env.DATA_DIR], ["EXECUTION_MODE", process.env.EXECUTION_MODE], ["GITHUB_TOKEN", process.env.GITHUB_TOKEN], ["CLINE_API_KEY", process.env.CLINE_API_KEY]]);
process.env.DATA_DIR = path.join(root, "data");
process.env.EXECUTION_MODE = "demo";
delete process.env.GITHUB_TOKEN;
delete process.env.CLINE_API_KEY;

const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts?readiness")).db;
const { assessProjectReadiness, liveReadinessFailure, remoteRepository } = await import("../src/lib/server/readiness.ts");
const { prepareBaselinePullRequest } = await import("../src/lib/server/baseline.ts");
const { hasCanonicalPriorityOptions, mapCanonicalPriorityOptions, mapCanonicalStatusOptions } = await import("../src/lib/server/github.ts");

async function git(cwd: string, args: string[]) {
  return execFile("git", ["-C", cwd, ...args]);
}

async function createCheckout(remote: string) {
  const checkout = fs.mkdtempSync(path.join(root, "baseline-checkout-"));
  await git(checkout, ["init", "-b", "main"]);
  await git(checkout, ["config", "user.email", "readiness@example.invalid"]);
  await git(checkout, ["config", "user.name", "Readiness Test"]);
  fs.writeFileSync(path.join(checkout, "README.md"), "fixture\n");
  await git(checkout, ["add", "README.md"]);
  await git(checkout, ["commit", "-m", "fixture"]);
  await git(checkout, ["remote", "add", "origin", remote]);
  await git(checkout, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return checkout;
}

function project(localPath: string): Project {
  return {
    id: "project-readiness",
    name: "Readiness",
    fullName: "example/readiness",
    description: "",
    initials: "R",
    accent: "#c9ff6b",
    localPath,
    defaultBranch: "main",
    githubProjectId: null,
    githubProjectUrl: null,
    isDemo: false,
    status: "attention",
    lastSyncedAt: new Date().toISOString(),
    activeAgents: 0,
    openTasks: 0,
    openPrs: 0,
  };
}

after(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("reports missing checkout and never includes secret or command output", async () => {
  process.env.GITHUB_TOKEN = "readiness-secret";
  const report = await assessProjectReadiness(project(path.join(root, "missing")));
  assert.equal(report.overallLevel, "registered");
  assert.equal(report.checks.some((item) => item.id === "checkout.path" && item.status === "blocker"), true);
  assert.equal(report.checks.some((item) => item.id === "github.priority_field" && item.status === "blocker"), true);
  assert.equal(JSON.stringify(report).includes("readiness-secret"), false);
  assert.equal(JSON.stringify(report).includes("stderr"), false);
});

test("accepts only matching GitHub remotes and reports ambiguous canonical statuses", () => {
  assert.equal(remoteRepository("https://github.com/example/readiness.git"), "example/readiness");
  assert.equal(remoteRepository("git@github.com:other/repository.git"), "other/repository");
  assert.equal(remoteRepository("https://gitlab.com/example/readiness.git"), null);

  const mappings = mapCanonicalStatusOptions([
    { id: "ready", name: "Ready" },
    { id: "todo", name: "Todo" },
    { id: "progress", name: "In Progress" },
    { id: "review", name: "Review" },
    { id: "blocked", name: "Blocked" },
    { id: "done", name: "Done" },
  ]);
  assert.equal(mappings.find((item) => item.concept === "ready")?.state, "ambiguous");
  assert.equal(mappings.find((item) => item.concept === "review")?.optionName, "Review");
  assert.equal(mappings.find((item) => item.concept === "blocked")?.state, "mapped");
});

test("requires the exact dashboard and Projects V2 P0-P3 priority contract", () => {
  const options = [
    { id: "p0", name: "P0" },
    { id: "p1", name: "P1" },
    { id: "p2", name: "P2" },
    { id: "p3", name: "P3" },
  ];
  const mappings = mapCanonicalPriorityOptions(options);
  assert.equal(hasCanonicalPriorityOptions(options), true);
  assert.deepEqual(mappings.map((mapping) => mapping.optionName), ["P0", "P1", "P2", "P3"]);
  assert.equal(mapCanonicalPriorityOptions([{ id: "p0-a", name: "P0" }, { id: "p0-b", name: "P0" }, ...options.slice(1)]).find((mapping) => mapping.label === "P0")?.state, "ambiguous");
  assert.equal(hasCanonicalPriorityOptions([...options, { id: "extra", name: "Urgent" }]), false);
});

test("keeps Demo inspection available while reporting a Live readiness blocker", async () => {
  const checkout = path.join(root, "demo-ready-checkout");
  fs.mkdirSync(checkout, { recursive: true });
  await git(checkout, ["init", "-b", "main"]);
  await git(checkout, ["config", "user.email", "readiness@example.invalid"]);
  await git(checkout, ["config", "user.name", "Readiness Test"]);
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ scripts: { test: "echo untrusted" } }));
  await git(checkout, ["add", "package.json"]);
  await git(checkout, ["commit", "-m", "fixture"]);

  const report = await assessProjectReadiness(project(checkout));
  assert.equal(report.overallLevel, "demo_ready");
  assert.match(liveReadinessFailure(report) ?? "", /Live mode is blocked by repository readiness/);
  assert.equal(JSON.stringify(report).includes("echo untrusted"), false);
});

test("does not mutate a repository when its baseline is already present", async () => {
  const checkout = await createCheckout("https://github.com/example/readiness.git");
  fs.writeFileSync(path.join(checkout, "WORKFLOW.md"), "local workflow\n");
  fs.mkdirSync(path.join(checkout, ".github"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".github", "pull_request_template.md"), "template\n");
  await git(checkout, ["add", "WORKFLOW.md", ".github/pull_request_template.md"]);
  await git(checkout, ["commit", "-m", "baseline present"]);

  const before = (await git(checkout, ["worktree", "list", "--porcelain"])).stdout;
  const result = await prepareBaselinePullRequest(project(checkout));
  const after = (await git(checkout, ["worktree", "list", "--porcelain"])).stdout;

  assert.deepEqual(result, { alreadyPresent: true, files: [] });
  assert.equal(after, before);
});

test("rejects a baseline request before mutation when origin does not match", async () => {
  const checkout = await createCheckout("https://github.com/other/repository.git");
  const before = (await git(checkout, ["status", "--short"])).stdout;

  await assert.rejects(() => prepareBaselinePullRequest(project(checkout)), /origin does not match/);

  assert.equal((await git(checkout, ["status", "--short"])).stdout, before);
  assert.equal((await git(checkout, ["worktree", "list", "--porcelain"])).stdout.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});

test("inspects a valid checkout without executing project validation", async () => {
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  await git(checkout, ["init", "-b", "main"]);
  await git(checkout, ["config", "user.email", "readiness@example.invalid"]);
  await git(checkout, ["config", "user.name", "Readiness Test"]);
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ scripts: { test: "echo untrusted" } }));
  await git(checkout, ["add", "package.json"]);
  await git(checkout, ["commit", "-m", "fixture"]);
  const report = await assessProjectReadiness(project(checkout));
  assert.equal(report.checks.find((item) => item.id === "checkout.git_root")?.status, "pass");
  assert.equal(report.checks.find((item) => item.id === "validation.commands")?.status, "pass");
  assert.equal(report.baseline.workflow, "default");
  assert.equal(report.baseline.proposal, "create_baseline_via_pr");
});