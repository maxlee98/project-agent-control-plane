import assert from "node:assert/strict";
import { test } from "node:test";
import { API_LIMITS, ApiRequestError, apiError, getIdempotencyKey, parseJsonBody, requiredString, requestFingerprint, validateProjectNodeId } from "../src/lib/server/api.ts";

test("rejects non-JSON content types before reading a body", async () => {
  await assert.rejects(
    parseJsonBody(new Request("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })),
    (error: unknown) => error instanceof ApiRequestError && error.code === "UNSUPPORTED_MEDIA_TYPE" && error.status === 415,
  );
});

test("rejects malformed, non-object, and oversized JSON", async () => {
  await assert.rejects(
    parseJsonBody(new Request("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" })),
    (error: unknown) => error instanceof ApiRequestError && error.code === "INVALID_JSON",
  );
  await assert.rejects(
    parseJsonBody(new Request("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "[]" })),
    (error: unknown) => error instanceof ApiRequestError && error.code === "INVALID_JSON",
  );
  await assert.rejects(
    parseJsonBody(new Request("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x".repeat(API_LIMITS.bodyBytes) }) })),
    (error: unknown) => error instanceof ApiRequestError && error.code === "PAYLOAD_TOO_LARGE" && error.details?.maxBytes === API_LIMITS.bodyBytes,
  );
});

test("validates fields without echoing input values", () => {
  assert.throws(() => requiredString({ title: "" }, "title", 10), (error: unknown) => error instanceof ApiRequestError && error.code === "VALIDATION_ERROR");
  assert.throws(() => requiredString({ title: "secret-value" }, "title", 4), (error: unknown) => error instanceof ApiRequestError && !error.message.includes("secret-value"));
});

test("requires and constrains idempotency keys", () => {
  assert.throws(() => getIdempotencyKey(new Request("http://localhost")), (error: unknown) => error instanceof ApiRequestError && error.code === "IDEMPOTENCY_KEY_REQUIRED");
  assert.throws(() => getIdempotencyKey(new Request("http://localhost", { headers: { "Idempotency-Key": "bad key" } })), (error: unknown) => error instanceof ApiRequestError && error.code === "INVALID_IDEMPOTENCY_KEY");
  assert.equal(getIdempotencyKey(new Request("http://localhost", { headers: { "Idempotency-Key": "task:123" } })), "task:123");
  assert.equal(requestFingerprint({ title: "same" }), requestFingerprint({ title: "same" }));
});

test("serializes a stable error without accepting arbitrary details", async () => {
  const response = apiError("VALIDATION_ERROR", "The request is invalid.", 400, { field: "title", maxLength: 200, secret: "do-not-return" } as never);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "VALIDATION_ERROR",
    message: "The request is invalid.",
    details: { field: "title", maxLength: 200 },
  });
});

test("validates Projects V2 identifiers", () => {
  assert.equal(validateProjectNodeId("PVT_project123"), "PVT_project123");
  assert.throws(() => validateProjectNodeId("project123"), (error: unknown) => error instanceof ApiRequestError && error.code === "INVALID_IDENTIFIER");
});