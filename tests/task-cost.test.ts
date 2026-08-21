import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Llms } from "@cline/sdk";

const previousNodeEnv = process.env.NODE_ENV;
const previousDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-task-cost-"));
process.env.NODE_ENV = "production";
process.env.DATA_DIR = dataDir;

const { calculateCatalogCostUsd, parseEstimatedCostCents, readRunUsage } = await import("../src/lib/server/cost.ts");
const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts?task-cost")).db;

after(() => {
  database.close();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("parses non-negative USD estimates into safe integer cents", () => {
  assert.equal(parseEstimatedCostCents(undefined), 0);
  assert.equal(parseEstimatedCostCents(""), 0);
  assert.equal(parseEstimatedCostCents("12.345"), 1235);
  assert.equal(parseEstimatedCostCents("1.005"), 101);
  assert.equal(parseEstimatedCostCents("$12.34"), null);
  assert.equal(parseEstimatedCostCents(0), 0);
  assert.equal(parseEstimatedCostCents(-1), null);
  assert.equal(parseEstimatedCostCents("not-a-number"), null);
  assert.equal(parseEstimatedCostCents(null), null);
  assert.equal(parseEstimatedCostCents(Number.POSITIVE_INFINITY), null);
});

test("prices cache-aware usage with model catalog rates and keeps SDK totals authoritative", async () => {
  assert.equal(calculateCatalogCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), 10.2675);
  assert.equal(calculateCatalogCostUsd({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1, cacheWriteTokens: 0 }, { input: 3, output: 15 }), null);

  const usage = await readRunUsage("anthropic", "claude-sonnet-4-5", { inputTokens: 12, outputTokens: 8, totalCost: 0.004321 });
  assert.deepEqual(usage, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    inputTokens: 12,
    outputTokens: 8,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0.004321,
    actualCostUsd: 0.004321,
    costSource: "sdk",
  });

  Llms.registerModel("cost-test-provider", "cost-test-model", { id: "cost-test-model", pricing: { input: 2, output: 4 } });
  const catalogUsage = await readRunUsage("cost-test-provider", "cost-test-model", { inputTokens: 1_000, outputTokens: 500 });
  assert.equal(catalogUsage?.actualCostUsd, 0.004);
  assert.equal(catalogUsage?.costSource, "catalog");

  const unavailable = await readRunUsage("provider-without-a-catalog", "unknown-model", { inputTokens: 12, outputTokens: 8 });
  assert.equal(unavailable?.actualCostUsd, null);
  assert.equal(unavailable?.costSource, "unavailable");
});

test("persists task cost estimates in cents and maps them back to USD", () => {
  const taskColumns = (database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name);
  const runColumns = (database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.equal(taskColumns.includes("estimated_cost_cents"), true);
  assert.equal(runColumns.includes("provider_id"), true);
  assert.equal(runColumns.includes("model_id"), true);
  assert.equal(runColumns.includes("actual_cost_micros"), true);

  const seededTask = repository.getTask("task-live-overview");
  assert.equal(seededTask?.estimatedCostUsd, 0);
  assert.equal(seededTask?.actualCostUsd, null);

  const task = repository.createTask({ projectId: "project-control-plane", title: "Task with a budget", estimatedCostCents: 1234 });
  assert.ok(task);
  assert.equal(task?.estimatedCostUsd, 12.34);
  assert.equal(database.prepare("SELECT estimated_cost_cents FROM tasks WHERE id = ?").get(task!.id)?.estimated_cost_cents, 1234);

  const updated = repository.updateTask(task!.id, { estimatedCostCents: 567 });
  assert.equal(updated?.estimatedCostUsd, 5.67);
  assert.equal(database.prepare("SELECT estimated_cost_cents FROM tasks WHERE id = ?").get(task!.id)?.estimated_cost_cents, 567);
  assert.equal(updated?.title, "Task with a budget");
});

test("aggregates immutable run costs while retaining the provider and model used by each run", () => {
  const task = repository.createTask({ projectId: "project-control-plane", title: "Task with model changes" });
  assert.ok(task);

  const previousProvider = process.env.CLINE_PROVIDER_ID;
  const previousModel = process.env.CLINE_MODEL_ID;
  process.env.CLINE_PROVIDER_ID = "anthropic";
  process.env.CLINE_MODEL_ID = "claude-haiku-4-5";
  const firstRun = repository.createRun({ taskId: task!.id, mode: "start" });
  assert.ok(firstRun);
  process.env.CLINE_PROVIDER_ID = "openai-native";
  process.env.CLINE_MODEL_ID = "gpt-5.4";
  const firstUpdated = repository.updateRun(firstRun!.id, {
    status: "completed",
    inputTokens: 1_000,
    outputTokens: 200,
    actualCostUsd: 0.001234,
    costSource: "sdk",
  });
  assert.equal(firstUpdated?.modelId, "claude-haiku-4-5");
  assert.equal(firstUpdated?.providerId, "anthropic");
  assert.equal(firstUpdated?.actualCostUsd, 0.001234);

  const secondRun = repository.createRun({ taskId: task!.id, mode: "retry" });
  assert.ok(secondRun);
  const secondUpdated = repository.updateRun(secondRun!.id, {
    status: "completed",
    inputTokens: 2_000,
    outputTokens: 400,
    actualCostUsd: 0.004567,
    costSource: "catalog",
  });
  assert.equal(secondUpdated?.providerId, "openai-native");
  assert.equal(secondUpdated?.modelId, "gpt-5.4");

  if (previousProvider === undefined) delete process.env.CLINE_PROVIDER_ID;
  else process.env.CLINE_PROVIDER_ID = previousProvider;
  if (previousModel === undefined) delete process.env.CLINE_MODEL_ID;
  else process.env.CLINE_MODEL_ID = previousModel;

  const aggregated = repository.getTask(task!.id);
  assert.equal(aggregated?.actualCostUsd, 0.005801);
  assert.equal(aggregated?.actualCostStatus, "available");
  assert.equal(repository.getRun(firstRun!.id)?.actualCostUsd, 0.001234);
  assert.equal(repository.getRun(firstRun!.id)?.modelId, "claude-haiku-4-5");
});

test("does not claim a zero actual when usage is still pending or unavailable", () => {
  const task = repository.createTask({ projectId: "project-control-plane", title: "Task without pricing" });
  assert.ok(task);
  const run = repository.createRun({ taskId: task!.id, mode: "start" });
  assert.ok(run);

  repository.updateRun(run!.id, { status: "running", costSource: "pending" });
  assert.equal(repository.getTask(task!.id)?.actualCostStatus, "pending");
  assert.equal(repository.getTask(task!.id)?.actualCostUsd, null);

  repository.updateRun(run!.id, { status: "failed", costSource: "unavailable", finishedAt: new Date().toISOString() });
  assert.equal(repository.getTask(task!.id)?.actualCostStatus, "unavailable");
  assert.equal(repository.getTask(task!.id)?.actualCostUsd, null);
});