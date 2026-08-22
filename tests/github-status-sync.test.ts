import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AgentRun, Task } from "../src/lib/domain.ts";

process.env.GITHUB_TOKEN = "test-token";

const github = await import("../src/lib/server/github.ts");
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
let issueState: "open" | "closed" = "open";
let statusName = "Done";
let addedIssue = false;
let issueListing: Array<Record<string, unknown>> = [];
let projectItemVisibilityDelay = 0;
let openPullRequests: Array<Record<string, unknown>> = [];
let pullRequestPostConflict = false;

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
    if (query.includes("addProjectV2ItemById")) {
      addedIssue = true;
      projectItemVisibilityDelay = 1;
      return response({ data: { addProjectV2ItemById: { item: { id: "item-14" } } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } } });
    const projectItemVisible = addedIssue && projectItemVisibilityDelay === 0;
    if (projectItemVisibilityDelay > 0) projectItemVisibilityDelay -= 1;
    return response({ data: {
      node: {
        __typename: "ProjectV2",
        fields: { nodes: [{ id: "field-status", name: "Status", options: [{ id: "option-todo", name: "Todo" }, { id: "option-progress", name: "In Progress" }, { id: "option-done", name: "Done" }] }] },
        items: { nodes: [
          {
            id: "item-10",
            content: { __typename: "Issue", id: "issue-node-10", number: 10, title: "Task #10", body: "", state: issueState === "closed" ? "CLOSED" : "OPEN", url: "https://github.com/maxlee98/project-agent-control-plane/issues/10", repository: { nameWithOwner: "maxlee98/project-agent-control-plane" }, labels: { nodes: [] } },
            fieldValues: { nodes: [{ field: { id: "field-status", name: "Status" }, name: statusName, optionId: statusName === "Done" ? "option-done" : "option-progress" }] },
          },
          ...(projectItemVisible ? [{
            id: "item-14",
            content: { __typename: "Issue", id: "issue-node-14", number: 14, title: "New Issue", body: "", state: "OPEN", url: "https://github.com/maxlee98/project-agent-control-plane/issues/14", repository: { nameWithOwner: "maxlee98/project-agent-control-plane" }, labels: { nodes: [] } },
            fieldValues: { nodes: [{ field: { id: "field-status", name: "Status" }, name: "Todo", optionId: "option-todo" }] },
          }] : []),
        ], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    } });
  }

  if (url.includes("/pulls?") && method === "GET") return response(openPullRequests);
  if (url.endsWith("/pulls") && method === "POST") {
    if (pullRequestPostConflict) {
      pullRequestPostConflict = false;
      openPullRequests = [{ number: 43, html_url: "https://github.com/maxlee98/project-agent-control-plane/pull/43" }];
      return response({ message: "Validation Failed" }, 422);
    }
    return response({ number: 42, html_url: "https://github.com/maxlee98/project-agent-control-plane/pull/42" });
  }
  if (url.endsWith("/issues/10") && method === "GET") return response({ number: 10, node_id: "issue-node-10", html_url: "https://github.com/maxlee98/project-agent-control-plane/issues/10", title: "Task #10", state: issueState });
  if (url.endsWith("/issues/10") && method === "PATCH") {
    issueState = (body?.state as "open" | "closed") ?? issueState;
    return response({ state: issueState });
  }
  if (url.includes("/issues?") && method === "GET") return response(issueListing);
  if (url.endsWith("/issues/9") && method === "GET") return response({ number: 9, node_id: "pr-node-9", html_url: "https://github.com/maxlee98/project-agent-control-plane/pull/9", title: "Stale PR reference", pull_request: { url: "https://github.com/maxlee98/project-agent-control-plane/pull/9" }, state: "open" });
  if (url.endsWith("/issues") && method === "POST") return response({ number: 18, node_id: "issue-node-18", html_url: "https://github.com/maxlee98/project-agent-control-plane/issues/18", title: body?.title, body: body?.body, state: "open" });
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
  addedIssue = false;
  projectItemVisibilityDelay = 0;
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
  addedIssue = false;
  projectItemVisibilityDelay = 0;
  issueListing = [];
  const result = await github.reconcileTaskStatus(project(), { issueNumber: 10, title: "Task #10", description: "", githubUrl: "https://github.com/maxlee98/project-agent-control-plane/issues/10" }, "in_progress");
  assert.equal(result.projectChanged, true);
  assert.equal(result.issueChanged, true);
  assert.equal(result.issueNumber, 10);
  const mutation = calls.find((call) => call.url.endsWith("/graphql") && String(call.body?.query).includes("updateProjectV2ItemFieldValue"));
  assert.equal((mutation?.body?.variables as Record<string, unknown>).optionId, "option-progress");
  assert.deepEqual(calls.at(-1)?.body, { state: "open", state_reason: "reopened" });
});

test("rejects missing project configuration and unmapped status options", async () => {
  await assert.rejects(() => github.listProjectItems({ ...project(), githubProjectId: null }), /no GitHub Projects V2 ID/);
  calls.length = 0;
  issueState = "open";
  statusName = "Custom Review";
  addedIssue = false;
  projectItemVisibilityDelay = 0;
  const items = await github.listProjectItems(project());
  assert.equal(items[0]?.statusMapped, false);
  await assert.rejects(() => github.reconcileProjectItemLifecycle(project(), items[0]!), /has no local workflow mapping/);
});

test("adds a newly created Issue to Projects V2 exactly once", async () => {
  calls.length = 0;
  issueState = "open";
  statusName = "Todo";
  addedIssue = false;
  projectItemVisibilityDelay = 0;
  issueListing = [];
  const result = await github.ensureProjectItem(project(), { number: 14, url: "https://github.com/maxlee98/project-agent-control-plane/issues/14", nodeId: "issue-node-14" });
  assert.deepEqual(result, { projectChanged: true, item: {
    projectItemId: "item-14",
    contentNodeId: "issue-node-14",
    statusFieldId: "field-status",
    statusOptionId: "option-todo",
    statusOptionName: "Todo",
    statusMapped: true,
    statusOptions: [{ id: "option-todo", name: "Todo" }, { id: "option-progress", name: "In Progress" }, { id: "option-done", name: "Done" }],
    issueNumber: 14,
    issueState: "open",
    title: "New Issue",
    description: "",
    status: "ready",
    labels: [],
    githubUrl: "https://github.com/maxlee98/project-agent-control-plane/issues/14",
  } });
  assert.equal(calls.filter((call) => String(call.body?.query).includes("addProjectV2ItemById")).length, 1);
  const second = await github.ensureProjectItem(project(), { number: 14, url: "https://github.com/maxlee98/project-agent-control-plane/issues/14", nodeId: "issue-node-14" });
  assert.equal(second.projectChanged, false);
  assert.equal(calls.filter((call) => String(call.body?.query).includes("addProjectV2ItemById")).length, 1);
});

test("creates a PR with one explicit closing canonical Issue reference", async () => {
  calls.length = 0;
  openPullRequests = [];
  pullRequestPostConflict = false;
  const now = new Date().toISOString();
  const task = {
    id: "task-10",
    projectId: "project-live",
    issueNumber: 10,
    title: "Task #10",
    description: "",
    status: "in_progress",
    priority: 3,
    labels: ["bug"],
    assignee: null,
    agentState: "succeeded",
    currentSummary: "Validated implementation.",
    branchName: "agent/task-10",
    prUrl: null,
    githubUrl: "https://github.com/maxlee98/project-agent-control-plane/issues/10",
    updatedAt: now,
    createdAt: now,
  } satisfies Task;
  const run = {
    id: "run-10",
    taskId: "task-10",
    projectId: "project-live",
    mode: "start",
    status: "completed",
    sessionId: null,
    branchName: "agent/task-10",
    workspacePath: null,
    progress: 100,
    currentActivity: "Pull request ready for review",
    startedAt: now,
    finishedAt: now,
    error: null,
    executionMode: "live",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    actualCostUsd: null,
    costSource: "unavailable",
    isActive: false,
    commitSha: "abc123",
    changedFiles: [],
    checks: [],
  } satisfies AgentRun;
  const result = await github.createPullRequest(project().fullName, task, run);
  assert.deepEqual(result, { number: 42, url: "https://github.com/maxlee98/project-agent-control-plane/pull/42" });
  const pullRequest = calls.find((call) => call.url.endsWith("/pulls") && call.method === "POST");
  assert.equal(pullRequest?.body?.title, "fix: Task #10");
  const pullRequestBody = String(pullRequest?.body?.body);
  assert.match(pullRequestBody, /\bFixes #10\b/);
  assert.equal(pullRequestBody.match(/#10/g)?.length, 1);
  assert.doesNotMatch(pullRequestBody, /\b(?:Refs|Closes|Resolves)\b/i);
  assert.doesNotMatch(pullRequestBody, /Automated handoff for task/i);
});

test("reuses an existing open PR when a retry reaches the same task branch", async () => {
  calls.length = 0;
  openPullRequests = [{ number: 41, html_url: "https://github.com/maxlee98/project-agent-control-plane/pull/41" }];
  pullRequestPostConflict = false;
  const task = { issueNumber: 10, title: "Task #10", currentSummary: "Validated implementation.", branchName: "agent/task-10" } as Task;
  const run = { branchName: "agent/task-10", commitSha: "abc123" } as AgentRun;

  const result = await github.createPullRequest(project().fullName, task, run);

  assert.deepEqual(result, { number: 41, url: "https://github.com/maxlee98/project-agent-control-plane/pull/41" });
  assert.equal(calls.some((call) => call.url.endsWith("/pulls") && call.method === "POST"), false);
  assert.equal(calls.some((call) => call.url.includes("/pulls?") && call.method === "GET"), true);
});

test("recovers an existing PR when GitHub reports a duplicate-create validation error", async () => {
  calls.length = 0;
  openPullRequests = [];
  pullRequestPostConflict = true;
  const task = { issueNumber: 10, title: "Task #10", currentSummary: "Validated implementation.", branchName: "agent/task-10" } as Task;
  const run = { branchName: "agent/task-10", commitSha: "abc123" } as AgentRun;

  const result = await github.createPullRequest(project().fullName, task, run);

  assert.deepEqual(result, { number: 43, url: "https://github.com/maxlee98/project-agent-control-plane/pull/43" });
  assert.equal(calls.filter((call) => call.url.endsWith("/pulls") && call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.url.includes("/pulls?") && call.method === "GET").length, 2);
});

test("refuses to create a PR without a canonical GitHub Issue", async () => {
  calls.length = 0;
  const task = { issueNumber: null, title: "Unlinked task", currentSummary: "", branchName: "agent/unlinked" } as Task;
  const run = { branchName: "agent/unlinked", commitSha: "abc123" } as AgentRun;
  await assert.rejects(() => github.createPullRequest(project().fullName, task, run), /canonical GitHub Issue/);
  assert.equal(calls.some((call) => call.url.endsWith("/pulls") && call.method === "POST"), false);
});

test("does not reuse a Pull Request reference and creates a real Issue", async () => {
  calls.length = 0;
  issueState = "open";
  statusName = "Todo";
  addedIssue = false;
  issueListing = [];
  const result = await github.resolveTaskIssue(project(), {
    issueNumber: 9,
    title: "Repair the stale task identity",
    description: "The local task must not point at a pull request.",
    githubUrl: "https://github.com/maxlee98/project-agent-control-plane/issues/9",
  });
  assert.equal(result.created, true);
  assert.equal(result.issue.number, 18);
  assert.equal(result.issue.url, "https://github.com/maxlee98/project-agent-control-plane/issues/18");
  assert.equal(calls.some((call) => call.url.endsWith("/issues/9")), true);
  assert.equal(calls.some((call) => call.url.includes("/issues?") && call.method === "GET"), true);
  assert.equal(calls.some((call) => call.url.endsWith("/issues") && call.method === "POST"), true);
});

test("falls back to an exact Issue title instead of reusing an unrelated number", async () => {
  calls.length = 0;
  issueListing = [{ number: 16, node_id: "issue-node-16", html_url: "https://github.com/maxlee98/project-agent-control-plane/issues/16", title: "Keep the exact task title", state: "open" }];
  const result = await github.resolveTaskIssue(project(), {
    issueNumber: 10,
    title: "Keep the exact task title",
    description: "",
    githubUrl: null,
  });
  assert.equal(result.created, false);
  assert.equal(result.issue.number, 16);
  assert.equal(calls.some((call) => call.url.endsWith("/issues") && call.method === "POST"), false);
});