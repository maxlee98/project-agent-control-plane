#!/usr/bin/env node

import fs from "node:fs";
import { assertValidPrBody, readTemplate } from "./pr-template.mjs";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const bodyFile = argumentValue(process.argv.slice(2), "--body-file");
const body = bodyFile ? fs.readFileSync(bodyFile, "utf8") : process.env.PR_BODY;
if (typeof body !== "string") {
  process.stderr.write("usage: verify-pr-template --body-file <path> or PR_BODY environment input\n");
  process.exit(2);
}

try {
  assertValidPrBody(readTemplate(), body);
  process.stdout.write("PR template verification passed\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "PR template verification failed"}\n`);
  process.exit(1);
}