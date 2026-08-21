import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const templatePath = ".github/ISSUE_TEMPLATE/task.md";
const configPath = ".github/ISSUE_TEMPLATE/config.yml";
const template = fs.readFileSync(templatePath, "utf8");
const config = fs.readFileSync(configPath, "utf8");

test("provides one generic issue template with consistent task metadata", () => {
  assert.match(template, /^---\nname: Task\nabout: .+\ntitle: "\[Task\]: "\nlabels: ""\nassignees: ""\n---/);

  for (const heading of [
    "Summary",
    "Context and evidence",
    "Problem",
    "Goals and non-goals",
    "Acceptance criteria",
    "Affected areas",
    "Validation",
    "Risks and rollback",
    "Follow-up questions",
  ]) {
    assert.match(template, new RegExp(`^## ${heading}$`, "m"), `missing issue section: ${heading}`);
  }

  assert.match(template, /^### Goals$/m);
  assert.match(template, /^### Non-goals$/m);
});

test("requires the generic issue template for GitHub issue creation", () => {
  assert.equal(config.trim(), "blank_issues_enabled: false");
});