#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const marker = "## ABSOLUTE TERMINAL HARD STOP";
const skillRoot = path.join(os.homedir(), ".agents", "skills");

const hardStop = [
  marker,
  "",
  "These rules are mandatory prohibitions, not preferences. The agent MUST refuse to send an",
  "unsafe command and MUST choose a patch-created script instead.",
  "",
  "- MUST NOT author files with cat >, cat >>, tee multiline input, or any heredoc marker (<<). A complete heredoc is not an exception for agent-authored work.",
  "- MUST NOT send bash -c, sh -c, zsh -c, shell interactive flags, eval, nested shells, command substitutions, unclosed quotes, backslash continuations, or long inline command chains.",
  "- MUST NOT start a Python REPL or use Python stdin, -, or -c for authored logic. MUST NOT use Node inline evaluation for authored logic.",
  "- All multiline, quoted, or multi-side-effect logic MUST be created with the editor/patch operation as an inspectable script file, read back, and executed separately.",
  "- In repositories with scripts/safe-run.mjs, every development command MUST run through the safe runner with a finite timeout.",
  "- A quote>, dquote>, heredoc>, bare >, Python >>>, or ... prompt means incomplete input: cancel immediately, classify the operation as unknown, inspect state, and never type a guessed delimiter or more source code.",
].join(String.fromCharCode(10));

const additions = {
  "terminal-reliability/SKILL.md": hardStop,
  "scripted-edit-reliability/SKILL.md": hardStop,
  "lld-driven-development/SKILL.md": hardStop,
};

function update(relativePath, section) {
  const target = path.join(skillRoot, relativePath);
  if (!fs.existsSync(target)) throw new Error(`missing global skill: ${target}`);
  const current = fs.readFileSync(target, "utf8");
  if (current.includes(marker)) return "already present";
  const temporary = `${target}.${process.pid}.tmp`;
  const next = `${current.trimEnd()}\n\n${section.trim()}\n`;
  fs.writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return "updated";
}

for (const [relativePath, section] of Object.entries(additions)) {
  process.stdout.write(`${relativePath}: ${update(relativePath, section)}\n`);
}