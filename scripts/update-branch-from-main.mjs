#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

const strategy = argumentValue(process.argv.slice(2), "--strategy");
if (!["update", "rebase"].includes(strategy)) {
  process.stderr.write("usage: update-branch-from-main --strategy update|rebase\n");
  process.exit(2);
}

const currentBranch = git(["branch", "--show-current"]).trim();
if (!currentBranch || currentBranch === "main") throw new Error("refusing to update or rebase main");
if (git(["status", "--porcelain"]).trim()) throw new Error("worktree must be clean before updating or rebasing");

git(["fetch", "origin", "main", "--prune"]);
git(strategy === "update" ? ["merge", "--no-edit", "origin/main"] : ["rebase", "origin/main"]);
git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
process.stdout.write(`branch updated strategy=${strategy} branch=${currentBranch} base=origin/main\n`);