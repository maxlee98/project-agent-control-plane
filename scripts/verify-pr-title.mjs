#!/usr/bin/env node

import { assertValidPrTitle } from "./pr-title.mjs";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const titleArgument = argumentValue(process.argv.slice(2), "--title");
const title = titleArgument ?? process.env.PR_TITLE;
if (typeof title !== "string") {
  process.stderr.write("usage: verify-pr-title --title <title> or PR_TITLE environment input\n");
  process.exit(2);
}

try {
  assertValidPrTitle(title);
  process.stdout.write("PR title verification passed\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "PR title verification failed"}\n`);
  process.exit(1);
}