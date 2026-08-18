import assert from "node:assert/strict";
import test from "node:test";
import { translateClineEvent } from "../src/lib/server/cline.ts";
import { shouldPublishGithubCheckpoint } from "../src/lib/domain.ts";

test("translates Cline content events into stable run events", () => {
  const toolStart = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "content_start", contentType: "tool", toolName: "read_file" } },
  });
  assert.deepEqual(toolStart, {
    type: "tool_started",
    message: "Agent started a tool",
    detail: "read_file",
    checkpoint: false,
  });

  const output = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "content_end", contentType: "text", text: "Implemented the adapter." } },
  });
  assert.equal(output?.type, "output_summary");
  assert.equal(output?.message, "Agent output summarized");
  assert.equal(output?.checkpoint, false);
});

test("translates completion and failure as stable checkpoint candidates", () => {
  const completed = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "done", text: "All checks passed." } },
  });
  assert.equal(completed?.type, "run_completed");
  assert.equal(completed?.checkpoint, false);

  const failed = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "error", error: new Error("provider failed"), recoverable: false, iteration: 2 } },
  });
  assert.equal(failed?.type, "run_failed");
  assert.equal(failed?.detail, "provider failed");
  assert.equal(failed?.checkpoint, true);
});

test("keeps chunks local and redacts sensitive output before callbacks", () => {
  const previous = process.env.CLINE_API_KEY;
  process.env.CLINE_API_KEY = "cline-event-test-secret";
  try {
    const chunk = translateClineEvent({ type: "chunk", payload: { chunk: "apiKey=cline-event-test-secret" } });
    assert.equal(chunk?.type, "output_chunk");
    assert.equal(chunk?.checkpoint, false);
    assert.equal(chunk?.detail?.includes("cline-event-test-secret"), false);
    assert.equal(chunk?.detail?.includes("[REDACTED_SECRET]"), true);
  } finally {
    if (previous === undefined) delete process.env.CLINE_API_KEY;
    else process.env.CLINE_API_KEY = previous;
  }
});

test("normalizes unknown Cline events without exposing the source vocabulary", () => {
  const event = translateClineEvent({ type: "future_cline_event", payload: { raw: "ignored" } });
  assert.deepEqual(event, {
    type: "unknown",
    message: "Agent update received",
    detail: null,
    checkpoint: false,
  });
});

test("limits GitHub checkpoints to meaningful run milestones", () => {
  assert.equal(shouldPublishGithubCheckpoint("validation_passed"), true);
  assert.equal(shouldPublishGithubCheckpoint("validation_failed"), true);
  assert.equal(shouldPublishGithubCheckpoint("run_failed"), true);
  assert.equal(shouldPublishGithubCheckpoint("run_stopped"), true);
  assert.equal(shouldPublishGithubCheckpoint("handoff_complete"), true);
  assert.equal(shouldPublishGithubCheckpoint("progress"), false);
  assert.equal(shouldPublishGithubCheckpoint("tool_started"), false);
  assert.equal(shouldPublishGithubCheckpoint("output_chunk"), false);
  assert.equal(shouldPublishGithubCheckpoint("run_completed"), false);
});