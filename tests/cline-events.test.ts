import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRunEventType, shouldPublishGithubCheckpoint } from "../src/lib/domain.ts";
import { translateClineEvent } from "../src/lib/server/cline.ts";

test("translates agent content into stable control-plane events", () => {
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

  const toolEnd = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "content_end", contentType: "tool", toolName: "read_file" } },
  });
  assert.equal(toolEnd?.type, "tool_finished");
  assert.equal(toolEnd?.message, "Agent finished a tool");

  const output = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "content_end", contentType: "text", text: "Implemented the adapter." } },
  });
  assert.deepEqual(output, {
    type: "output_summary",
    message: "Agent output summarized",
    detail: "Implemented the adapter.",
    checkpoint: false,
  });
});

test("translates progress, stream, hook, and terminal events without source vocabulary", () => {
  assert.equal(translateClineEvent({ type: "agent_event", payload: { event: { type: "iteration_start", iteration: 2 } } })?.detail, "Iteration 2");
  assert.equal(translateClineEvent({ type: "agent_event", payload: { event: { type: "notice", message: "Compacting context" } } })?.type, "progress");
  assert.equal(translateClineEvent({ type: "hook", payload: { hookEventName: "tool_result", toolName: "search" } })?.type, "tool_finished");
  assert.equal(translateClineEvent({ type: "status", payload: { status: "running" } })?.message, "Agent status updated");
  assert.equal(translateClineEvent({ type: "ended", payload: { reason: "aborted" } })?.type, "run_failed");

  const unknown = translateClineEvent({ type: "future_cline_event", payload: { raw: "ignored" } });
  assert.deepEqual(unknown, {
    type: "unknown",
    message: "Agent update received",
    detail: null,
    checkpoint: false,
  });
  assert.equal(unknown?.message.includes("future_cline_event"), false);
});

test("redacts and bounds selected details while excluding session identifiers", () => {
  const chunk = translateClineEvent({
    type: "chunk",
    payload: { sessionId: "session-secret-id", chunk: `apiKey=cline-event-test-secret ${"x".repeat(3_000)}` },
  });
  assert.equal(chunk?.type, "output_chunk");
  assert.equal(chunk?.detail?.includes("cline-event-test-secret"), false);
  assert.equal(chunk?.detail?.includes("[REDACTED_SECRET]"), true);
  assert.equal(chunk?.detail?.includes("session-secret-id"), false);
  assert.equal((chunk?.detail?.length ?? 0) <= 2_001, true);

  const event = translateClineEvent({
    type: "agent_event",
    payload: { sessionId: "session-secret-id", event: { type: "content_start", contentType: "text", text: "working" } },
  });
  assert.equal(event?.detail?.includes("session-secret-id"), false);
});

test("marks terminal outcomes and checkpoint policy without changing runtime authority", () => {
  const completed = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "done", reason: "completed", text: "All checks passed." } },
  });
  assert.equal(completed?.type, "run_completed");
  assert.equal(completed?.checkpoint, false);

  const failed = translateClineEvent({
    type: "agent_event",
    payload: { event: { type: "done", reason: "max_iterations", text: "Stopped early." } },
  });
  assert.equal(failed?.type, "run_failed");
  assert.equal(failed?.checkpoint, true);

  assert.equal(shouldPublishGithubCheckpoint("validation_passed"), true);
  assert.equal(shouldPublishGithubCheckpoint("run_failed"), true);
  assert.equal(shouldPublishGithubCheckpoint("run_completed"), false);
  assert.equal(shouldPublishGithubCheckpoint("output_chunk"), false);
});

test("normalizes legacy and unsupported persisted event values", () => {
  assert.equal(normalizeRunEventType("cline"), "progress");
  assert.equal(normalizeRunEventType("content_end"), "unknown");
  assert.equal(normalizeRunEventType("future_event"), "unknown");
  assert.equal(normalizeRunEventType(null), "unknown");
});