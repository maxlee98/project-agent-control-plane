import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";

const github = await import("../src/lib/server/github.ts");
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
let issueState: "open" | "closed" = "open";
let statusName = "Done";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function project() {
  return {
    id: "project-live",
    name: "Control Plane",
    fullName: "maxlee98/project-agent-control-plane",
    description: "",
    initials: "CP",
    accent: "#c9ff6b",
    localPath: "/tmp/control-plane",
    defaultBranch: "main",
    githubProjectId: "PVT_project",
    githubProjectUrl: null,
    isDemo: false,
    status: "connected" as const,
    lastSyncedAt: new Date().toISOString(),
    activeAgents: 0,
    openTasks: 1,
    openPrs: 0,
  };
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  calls.push({ url, method, body });

  if (url.endsWith("/graphql")) {
    const query = String(body?.query ?? "");
    if (query.includes("updateProjectV2ItemFieldValue")) return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } } });
    return response({ data: {
      node: {
        fields: { nodes: [{ id: "field-status", name: "Status", options: [{ id: "option-todo", name: "Todo" }, { id: "option-progress", name: "In Progress" }, { id: "option-done", name: "Done" }] }] },
        items: { nodes: [{
          id: "item-10",
          content: { __typename: "Issue", number: 10, title: "Task #10", body: "", state: issueState === "closed" ? "CLOSED" : "OPEN", url: "https://github.com/maxlee98/project-agent-control-plane/issues/10", labels: { nodes: [] } },
          fieldValues: { nodes: [{ field: { id: "field-status", name: "Status" }, name: statusName, optionId: statusName === "Done" ? "option-done" : "option-progress" }] },
        }] },
      },
    } });
  }

  if (url.endsWith("/issues/10") && method === "GET") return response({ state: issueState });
  if (url.endsWith("/issues/10") && method === "PATCH") {
    issueState = (body?.state as "open" | "closed") ?? issueState;
    return response({ state: issueState });
  }
  return response({ message: "Unexpected test request" }, 404);
};

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GITHUB_TOKEN;
});

test("reads Projects V2 metadata and repairs a Done issue lifecycle", async () => {
  calls.length = 0;
  issueState = "open";
  statusName = "Done";
  const items = await github.listProjectItems(project());
  assert.equal(items[0]?.status, "done");
  assert.equal(items[0]?.statusMapped, true);
  assert.equal(items[0]?.projectItemId, "item-10");
  const result = await github.reconcileProjectItemLifecycle(project(), items[0]!);
  assert.deepEqual(result, { issueChanged: true });
  assert.equal(issueState, "closed");
  assert.deepEqual(calls.at(-1)?.body, { state: "closed", state_reason: "completed" });
});

test("updates the Projects V2 option and reopens an issue for a non-Done status", async () => {
  calls.length = 0;
  issueState = "closed";
  statusName = "Done";
  const result = await github.reconcileTaskStatus(project(), 10, "in_progress");
  assert.deepEqual(result, { projectChanged: true, issueChanged: true });
  const mutation = calls.find((call) => call.url.endsWith("/graphql") && String(call.body?.query).includes("updateProjectV2ItemFieldValue"));
  assert.equal((mutation?.body?.variables as Record<string, unknown>).optionId, "option-progress");
  assert.deepEqual(calls.at(-1)?.body, { state: "open", state_reason: "reopened" });
});

test("rejects missing project configuration and unmapped status options", async () => {
  await assert.rejects(() => github.listProjectItems({ ...project(), githubProjectId: null }), /no GitHub Projects V2 ID/);
  calls.length = 0;
  issueState = "open";
  statusName = "Custom Review";
  const items = await github.listProjectItems(project());
  assert.equal(items[0]?.statusMapped, false);
  await assert.rejects(() => github.reconcileProjectItemLifecycle(project(), items[0]!), /has no local workflow mapping/);
});