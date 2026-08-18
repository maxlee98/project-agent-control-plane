import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Project, RunCheck, Task } from "../domain";

const execFile = promisify(execFileCallback);

export function expandHome(value: string) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

async function git(cwd: string, args: string[], timeout = 30_000) {
  return execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 });
}

export interface WorkspaceHandle {
  repositoryPath: string;
  workspacePath: string;
  branchName: string;
  reused: boolean;
}

export async function prepareWorkspace(project: Project, task: Task, options: { runId: string; mode: "start" | "continue" | "retry"; continuationWorkspacePath?: string | null }): Promise<WorkspaceHandle> {
  const repositoryPath = path.resolve(expandHome(project.localPath));
  const root = path.resolve(expandHome(process.env.WORKSPACE_ROOT ?? path.join(os.homedir(), ".project-agent-control-plane", "workspaces")));
  await fs.mkdir(root, { recursive: true });
  const rootForProject = path.join(root, safeName(project.fullName));

  const repositoryCheck = await git(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (path.resolve(repositoryCheck.stdout.trim()) !== repositoryPath) throw new Error(`Configured checkout is not the expected Git repository: ${repositoryPath}`);

  const worktrees = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
  if (options.mode === "continue") {
    const workspacePath = options.continuationWorkspacePath ? path.resolve(options.continuationWorkspacePath) : "";
    if (!workspacePath || !worktrees.stdout.includes(`worktree ${workspacePath}`)) {
      throw new Error("Continuation workspace is unavailable. Start a retry to create a fresh workspace from the current default branch.");
    }
    const currentBranch = (await git(workspacePath, ["branch", "--show-current"])).stdout.trim();
    return { repositoryPath, workspacePath, branchName: currentBranch || task.branchName || "unknown", reused: true };
  }

  const workspacePath = path.join(rootForProject, safeName(task.id), safeName(options.runId));
  const branchName = `agent/${task.issueNumber ?? task.id}-${safeName(task.title).slice(0, 34)}-${safeName(options.runId).slice(-8)}`;
  if (worktrees.stdout.includes(`worktree ${workspacePath}`)) throw new Error(`Fresh run workspace already exists: ${workspacePath}`);
  try {
    await fs.access(workspacePath);
    throw new Error(`Fresh run workspace path already exists outside Git worktree tracking: ${workspacePath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Fresh run workspace path already exists")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  await git(repositoryPath, ["worktree", "add", "-b", branchName, workspacePath, `origin/${project.defaultBranch}`], 60_000);
  return { repositoryPath, workspacePath, branchName, reused: false };
}

export async function collectChangedFiles(workspacePath: string) {
  const result = await git(workspacePath, ["status", "--short"]);
  return result.stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
}

async function commandExists(workspacePath: string, command: string) {
  try { await fs.access(path.join(workspacePath, command)); return true; } catch { return false; }
}

export async function detectChecks(workspacePath: string): Promise<RunCheck[]> {
  const checks: RunCheck[] = [];
  if (await commandExists(workspacePath, "package.json")) {
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(workspacePath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (packageJson.scripts?.typecheck) checks.push({ name: "Typecheck", command: "npm run typecheck", status: "pending" });
      if (packageJson.scripts?.test) checks.push({ name: "Tests", command: "npm test", status: "pending" });
      if (packageJson.scripts?.build) checks.push({ name: "Build", command: "npm run build", status: "pending" });
    } catch { /* The agent will report malformed project metadata. */ }
  }
  if (await commandExists(workspacePath, "pytest.ini") || await commandExists(workspacePath, "pyproject.toml")) checks.push({ name: "Pytest", command: "pytest", status: "pending" });
  return checks;
}

export async function runChecks(workspacePath: string, checks: RunCheck[], onUpdate: (checks: RunCheck[]) => void) {
  const results = [...checks];
  for (let index = 0; index < results.length; index += 1) {
    const check = results[index];
    results[index] = { ...check, status: "running" };
    onUpdate([...results]);
    const started = Date.now();
    try {
      const [command, ...args] = check.command.split(" ");
      const result = await execFile(command, args, { cwd: workspacePath, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      results[index] = { ...check, status: "passed", output: `${result.stdout}${result.stderr}`.slice(-4000), durationMs: Date.now() - started };
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      results[index] = { ...check, status: "failed", output: `${detail.stdout ?? ""}${detail.stderr ?? ""}${detail.message ?? ""}`.slice(-4000), durationMs: Date.now() - started };
      onUpdate([...results]);
      return results;
    }
    onUpdate([...results]);
  }
  return results;
}

export async function commitAndPush(workspace: WorkspaceHandle, title: string) {
  const changedFiles = await collectChangedFiles(workspace.workspacePath);
  if (!changedFiles.length) throw new Error("The agent completed without changing any files; no commit or PR was created.");
  await git(workspace.workspacePath, ["add", "-A"]);
  await git(workspace.workspacePath, ["commit", "-m", `agent: ${title}`], 60_000);
  const sha = (await git(workspace.workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
  await git(workspace.workspacePath, ["push", "--set-upstream", "origin", workspace.branchName], 120_000);
  return { sha, changedFiles };
}

export async function removeWorkspace(workspace: WorkspaceHandle) {
  try { await git(workspace.repositoryPath, ["worktree", "remove", "--force", workspace.workspacePath], 60_000); } catch { /* Preserve failed workspaces for inspection. */ }
}