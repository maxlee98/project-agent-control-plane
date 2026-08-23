import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Project } from "../domain";
import { createBaselinePullRequest } from "./github";
function expandHome(value: string) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

const execFile = promisify(execFileCallback);

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "repository";
}

async function git(cwd: string, args: string[], timeout = 30_000) {
  return execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 512 * 1024 });
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface BaselinePullRequest {
  branchName: string;
  url: string;
  number: number;
  files: string[];
}

/**
 * Install only missing control-plane baseline files in an isolated worktree and publish them as a
 * reviewable pull request. This function is called only by the explicit approval route.
 */
export async function prepareBaselinePullRequest(project: Project): Promise<BaselinePullRequest | { alreadyPresent: true; files: [] }> {
  const repositoryPath = await fs.realpath(path.resolve(expandHome(project.localPath)));
  const root = path.resolve((await git(repositoryPath, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (root !== repositoryPath) throw new Error("The configured checkout must be the repository root.");
  const baseBranch = project.defaultBranch.trim() || "main";
  await git(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`]);

  const baselineFiles = [
    { target: "WORKFLOW.md", source: path.resolve(process.cwd(), "workflows/default/WORKFLOW.md") },
    { target: path.join(".github", "pull_request_template.md"), source: path.resolve(process.cwd(), ".github/pull_request_template.md") },
  ];
  const missingFiles = [] as typeof baselineFiles;
  for (const file of baselineFiles) {
    if (!await exists(path.join(repositoryPath, file.target))) missingFiles.push(file);
  }
  if (!missingFiles.length) return { alreadyPresent: true, files: [] };

  const workspaceRoot = path.resolve(expandHome(process.env.WORKSPACE_ROOT ?? path.join(os.homedir(), ".project-agent-control-plane", "workspaces")));
  const branchName = `agent/baseline-${safeName(project.fullName)}-${randomUUID().slice(0, 8)}`;
  const workspacePath = path.join(workspaceRoot, "_baselines", safeName(project.fullName), randomUUID());
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  try {
    await git(repositoryPath, ["worktree", "add", "-b", branchName, workspacePath, `origin/${baseBranch}`], 60_000);
    for (const file of missingFiles) {
      await fs.mkdir(path.dirname(path.join(workspacePath, file.target)), { recursive: true });
      await fs.copyFile(file.source, path.join(workspacePath, file.target));
    }
    await git(workspacePath, ["add", "--", ...missingFiles.map((file) => file.target)]);
    const changed = (await git(workspacePath, ["diff", "--cached", "--name-only"])).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!changed.length) return { alreadyPresent: true, files: [] };
    await git(workspacePath, ["commit", "-m", "chore: add control-plane repository baseline"], 60_000);
    await git(workspacePath, ["push", "--set-upstream", "origin", branchName], 120_000);
    const pullRequest = await createBaselinePullRequest(project.fullName, branchName, baseBranch);
    return { branchName, url: pullRequest.url, number: pullRequest.number, files: changed };
  } finally {
    try { await git(repositoryPath, ["worktree", "remove", "--force", workspacePath], 60_000); } catch { /* Preserve a failed approved action for operator inspection. */ }
  }
}