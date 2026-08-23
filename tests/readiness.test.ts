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
const { assessProjectReadiness, remoteRepository } = await import("../src/lib/server/readiness.ts");
const { mapCanonicalStatusOptions } = await import("../src/lib/server/github.ts");

async function git(cwd: string, args: string[]) {
  return execFile("git", ["-C", cwd, ...args]);
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