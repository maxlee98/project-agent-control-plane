import type { AgentRun, Project, Task, TaskStatus } from "../domain";

function githubRequest(path: string, init: RequestInit = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured.");
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...init.headers },
  });
}

function repoParts(fullName: string) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository: ${fullName}`);
  return { owner, repo };
}

async function readResponse(response: Response) {
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body.message ?? "request failed"}`);
  return body as Record<string, unknown>;
}

async function graphql<T>(query: string, variables: Record<string, unknown>) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured.");
  const response = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors?.map((error) => error.message).join(", ") ?? "request failed"}`);
  return body.data as T;
}

function statusFromLabel(value: string | undefined): TaskStatus {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "ready") return "ready";
  if (normalized === "in_progress" || normalized === "in progress") return "in_progress";
  if (normalized === "agent_review" || normalized === "agent review") return "agent_review";
  if (normalized === "human_review" || normalized === "human review") return "human_review";
  if (normalized === "blocked") return "blocked";
  if (normalized === "done") return "done";
  return "inbox";
}

export async function listProjectItems(project: Project) {
  if (!project.githubProjectId) throw new Error("This repository has no GitHub Projects V2 ID. Add it in the repository settings before syncing.");
  type ProjectField = { id: string; name: string; options?: Array<{ id: string; name: string }> };
  type ProjectItem = {
    id: string;
    content?: {
      __typename: string;
      number?: number;
      title?: string;
      body?: string;
      url?: string;
      repository?: { nameWithOwner: string };
      labels?: { nodes: Array<{ name: string }> };
    };
    fieldValues: { nodes: Array<{ field?: { id: string; name: string }; name?: string }> };
  };
  type ProjectData = { node: { fields: { nodes: ProjectField[] }; items: { nodes: ProjectItem[] } } };
  const data = await graphql<ProjectData>(`query($id:ID!) { node(id:$id) { ... on ProjectV2 { fields(first:50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } items(first:100) { nodes { id content { __typename ... on Issue { number title body url repository { nameWithOwner } labels(first:20) { nodes { name } } } } fieldValues(first:20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2SingleSelectField { id name } } name } } } } } } }`, { id: project.githubProjectId });
  const statusField = data.node.fields.nodes.find((field) => field.name.toLowerCase() === "status");
  return data.node.items.nodes.flatMap((item) => {
    if (!item.content || item.content.__typename !== "Issue" || !item.content.number) return [];
    const statusValue = item.fieldValues.nodes.find((value) => value.field?.id === statusField?.id)?.name;
    return [{ issueNumber: item.content.number, title: item.content.title ?? "Untitled issue", description: item.content.body ?? "", status: statusFromLabel(statusValue), labels: item.content.labels?.nodes.map((label) => label.name.toLowerCase()) ?? [], githubUrl: item.content.url ?? null }];
  });
}

export async function createPullRequest(fullName: string, task: Task, run: AgentRun) {
  const { owner, repo } = repoParts(fullName);
  const body = await readResponse(await githubRequest(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: task.title, head: run.branchName, base: process.env.GITHUB_DEFAULT_BRANCH ?? "main", body: `Automated handoff for task ${task.issueNumber ? `#${task.issueNumber}` : task.id}.\n\n${task.currentSummary}\n\nCommit: ${run.commitSha ?? "not recorded"}` }) }));
  return { url: String(body.html_url), number: Number(body.number) };
}

export async function publishComment(fullName: string, issueNumber: number, body: string) {
  const { owner, repo } = repoParts(fullName);
  await readResponse(await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) }));
}

export async function createIssue(fullName: string, title: string, body: string) {
  const { owner, repo } = repoParts(fullName);
  const result = await readResponse(await githubRequest(`/repos/${owner}/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) }));
  return { number: Number(result.number), url: String(result.html_url) };
}