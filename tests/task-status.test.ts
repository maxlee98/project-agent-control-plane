import assert from "node:assert/strict";
import { test } from "node:test";
import { BOARD_COLUMNS, getColumnLabel, normalizeTaskStatus } from "../src/lib/domain.ts";

test("uses Review as the canonical displayed handoff label", () => {
  assert.equal(getColumnLabel("human_review"), "Review");
  assert.equal(BOARD_COLUMNS.some((column) => column.id === "agent_review"), false);
});

test("normalizes legacy review status spellings", () => {
  for (const value of ["agent_review", "Agent Review", "in_review", "In Review", "human_review", "Review"]) {
    assert.equal(normalizeTaskStatus(value), "human_review");
  }
});