#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const globalSkills = [
  path.join(os.homedir(), ".agents", "skills", "terminal-reliability", "SKILL.md"),
  path.join(os.homedir(), ".agents", "skills", "scripted-edit-reliability", "SKILL.md"),
  path.join(os.homedir(), ".agents", "skills", "lld-driven-development", "SKILL.md"),
];
const repositoryFiles = [
  "AGENTS.md",
  "LLD/terminal-hard-stop-enforcement.md",
  "scripts/safe-run.mjs",
  "scripts/install-terminal-hardening.mjs",
  "scripts/create-hard-stop-pr.mjs",
  "tests/safe-run.test.ts",
  "docs/terminal-reliability.md",
  "workflows/default/WORKFLOW.md",
];

for (const target of globalSkills) {
  if (!fs.existsSync(target)) throw new Error(`missing global skill: ${target}`);
  const content = fs.readFileSync(target, "utf8");
  if (!content.includes("ABSOLUTE TERMINAL HARD STOP")) throw new Error(`missing hard-stop marker: ${target}`);
  if (!content.includes("quote>")) throw new Error(`missing continuation recovery: ${target}`);
}

for (const relativePath of repositoryFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) throw new Error(`missing repository file: ${relativePath}`);
}

const runner = fs.readFileSync(path.join(root, "scripts/safe-run.mjs"), "utf8");
for (const requirement of ["shell: false", "stdio: [\"ignore\", \"pipe\", \"pipe\"]", "timeout after", "output limit exceeded"]) {
  if (!runner.includes(requirement)) throw new Error(`runner requirement missing: ${requirement}`);
}

process.stdout.write("hard-stop verification passed\n");