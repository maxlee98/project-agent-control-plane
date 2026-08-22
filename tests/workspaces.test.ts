import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Project, Task } from "../src/lib/domain.ts";
import { prepareWorkspace, removeWorkspace, type WorkspaceHandle } from "../src/lib/server/workspaces.ts";

const execFile = promisify(execFileCallback);
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-workspaces-"));
const checkoutPath = path.join(runtimeRoot, "checkout");
const remotePath = path.join(runtimeRoot, "origin.git");
const workspaceRoot = path.join(runtimeRoot, "workspaces");
const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
const handles: WorkspaceHandle[] = [];

async function git(cwd: string, args: string[]) {
  return execFile("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 });
}

async function createRepository() {
  fs.mkdirSync(checkoutPath, { recursive: true });
  await git(checkoutPath, ["init", "-b", "main"]);
  await git(checkoutPath, ["config", "user.email", "worktree-tests@example.invalid"]);
  await git(checkoutPath, ["config", "user.name", "Worktree Tests"]);
  fs.writeFileSync(path.join(checkoutPath, "README.md"), "worktree fixture\n");
  await git(checkoutPath, ["add", "README.md"]);
  await git(checkoutPath, ["commit", "-m", "initial fixture"]);
  await git(runtimeRoot, ["init", "--bare", remotePath]);
  await git(checkoutPath, ["remote", "add", "origin", remotePath]);
  await git(checkoutPath, ["push", "--set-upstream", "origin", "main"]);
}

const project = {
  id: "project-fixture",
  name: "Repository",
  fullName: "owner/repository",
  description: "",
  initials: "R",
  accent: "#ffffff",
  localPath: checkoutPath,
  defaultBranch: "main",
  githubProjectId: null,
  githubProjectUrl: null,
  isDemo: false,
  status: "connected",
  lastSyncedAt: new Date().toISOString(),
  activeAgents: 0,
  openTasks: 0,
  openPrs: 0,
} satisfies Project;

const task = {
  id: "task-1",
  projectId: project.id,
  issueNumber: 42,
  title: "Keep workspaces isolated",
  description: "",
  estimatedCostUsd: 0,
  actualCostUsd: null,
  actualCostStatus: "not_started",
  status: "ready",
  priority: 2,
  labels: [],
  assignee: "You",
  agentState: "idle",
  currentSummary: "",
  branchName: null,
  prUrl: null,
  githubUrl: null,
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
} satisfies Task;

before(async () => {
  process.env.WORKSPACE_ROOT = workspaceRoot;
  await createRepository();
});

after(async () => {
  for (const handle of handles) await removeWorkspace(handle);
  if (previousWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test("creates deterministic run-scoped worktrees and branches", async () => {
  const first = await prepareWorkspace(project, task, { runId: "run-10", mode: "start" });
  const second = await prepareWorkspace(project, task, { runId: "run-11", mode: "retry" });
  handles.push(first, second);

  assert.equal(first.reused, false);
  assert.equal(first.workspacePath, path.join(await fs.promises.realpath(workspaceRoot), "owner-repository", "task-1", "run-10"));
  assert.equal(first.branchName, "agent/42-Keep-workspaces-isolated-run-10");
  assert.notEqual(first.workspacePath, second.workspacePath);
  assert.notEqual(first.branchName, second.branchName);
  assert.equal((await git(first.workspacePath, ["branch", "--show-current"])).stdout.trim(), first.branchName);
  assert.equal((await git(second.workspacePath, ["branch", "--show-current"])).stdout.trim(), second.branchName);
});

test("rejects a fresh run collision instead of reusing the existing worktree", async () => {
  await assert.rejects(
    () => prepareWorkspace(project, task, { runId: "run-10", mode: "start" }),
    /Fresh run workspace already exists|Fresh run workspace path already exists/,
  );
});

test("rejects a fresh run path occupied outside Git worktree tracking", async () => {
  const collisionPath = path.join(workspaceRoot, "owner-repository", "task-1", "run-12");
  fs.mkdirSync(collisionPath, { recursive: true });
  await assert.rejects(
    () => prepareWorkspace(project, task, { runId: "run-12", mode: "retry" }),
    /Fresh run workspace path already exists outside Git worktree tracking/,
  );
  fs.rmSync(collisionPath, { recursive: true, force: true });
});

test("only explicitly continued registered worktrees can be reused", async () => {
  const existing = handles.find((handle) => handle.workspacePath.endsWith(`${path.sep}run-10`));
  assert.ok(existing);
  const continued = await prepareWorkspace(project, task, {
    runId: "new-run",
    mode: "continue",
    continuationWorkspacePath: existing.workspacePath,
  });

  assert.deepEqual(continued, { ...existing, reused: true });
  await assert.rejects(
    () => prepareWorkspace(project, task, { runId: "new-run", mode: "continue", continuationWorkspacePath: `${existing.workspacePath}-suffix` }),
    /Continuation workspace is unavailable/,
  );
  await assert.rejects(
    () => prepareWorkspace(project, task, { runId: "new-run", mode: "continue", continuationWorkspacePath: existing.workspacePath.slice(0, -1) }),
    /Continuation workspace is unavailable/,
  );
  await assert.rejects(
    () => prepareWorkspace(project, task, { runId: "new-run", mode: "continue", continuationWorkspacePath: remotePath }),
    /Continuation workspace is unavailable/,
  );
});