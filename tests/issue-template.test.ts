import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const templatePath = ".github/ISSUE_TEMPLATE.md";
const template = fs.readFileSync(templatePath, "utf8");

test("the repository provides one generic issue template", () => {
  assert.equal(fs.existsSync(templatePath), true);
  for (const heading of [
    "## Issue type",
    "## Problem",
    "## Goals",
    "## Non-goals",
    "## Requirements and acceptance criteria",
    "## Relevant context",
    "## Proposed approach",
    "## Validation",
    "## Risks and rollback",
    "## Follow-ups",
  ]) {
    assert.match(template, new RegExp(`^${heading}$`, "m"));
  }
});

test("the issue template does not contain sensitive configuration guidance", () => {
  assert.doesNotMatch(template, /\.env(?:\.local)?|GITHUB_TOKEN|CLINE_API_KEY|Authorization:/i);
});
