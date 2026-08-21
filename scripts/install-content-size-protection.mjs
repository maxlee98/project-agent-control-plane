#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, ".agents", "skills", "content-size-protection", "SKILL.md");
const target = path.join(os.homedir(), ".agents", "skills", "content-size-protection", "SKILL.md");
const requiredMarkers = ["name: content-size-protection", "48,000 characters", "OpenRouter 403 size-filter recovery"];

if (!fs.existsSync(source)) throw new Error(`missing repository skill: ${source}`);
const content = fs.readFileSync(source, "utf8");
for (const marker of requiredMarkers) {
  if (!content.includes(marker)) throw new Error(`repository skill is missing required marker: ${marker}`);
}

fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) {
  process.stdout.write("content-size-protection: already installed\n");
  process.exit(0);
}

const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
try {
  fs.renameSync(temporary, target);
} catch (error) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  throw error;
}

if (fs.readFileSync(target, "utf8") !== content) throw new Error("global skill readback verification failed");
process.stdout.write("content-size-protection: installed\n");