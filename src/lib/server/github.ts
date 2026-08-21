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

async function readResponse<T = Record<string, unknown>>(response: Response) {
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body.message ?? "request failed"}`);
  return body as T;
}

async function graphql<T>(query: string, variables: Record<string, unknown>) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured.");
  const response = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors?.map((error) => error.message).join(", ") ?? "request failed"}`);
  return body.data as T;
}

function statusFromLabel(value: string | undefined): TaskStatus {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "ready" || normalized === "todo" || normalized === "backlog") return "ready";
  if (normalized === "in_progress") return "in_progress";
  if (normalized === "agent_review" || normalized === "in_review") return "agent_review";
  if (normalized === "human_review") return "human_review";
  if (normalized === "blocked") return "blocked";
  if (normalized === "done" || normalized === "complete" || normalized === "completed") return "done";
  return "inbox";
}

type StatusOption = { id: string; name: string };

type IssueApiRecord = {
  number?: number;
  node_id?: string;
  html_url?: string;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  pull_request?: unknown;
};

type PullRequestApiRecord = {
  number?: number;
  html_url?: string;
};

type PullRequestReference = {
  number: number;
  url: string;
};

export type ResolvedIssue = {
  number: number;
  url: string;
  nodeId: string;
  title: string;
  body: string;
  state: "open" | "closed";
};

export type SyncedProjectItem = {
  projectItemId: string;
  contentNodeId: string | null;
  statusFieldId: string | null;
  statusOptionId: string | null;
  statusOptionName: string | null;
  statusMapped: boolean;
  statusOptions: StatusOption[];
  issueNumber: number;
  issueState: "open" | "closed";
  title: string;
  description: string;
  status: TaskStatus;
  labels: string[];
  githubUrl: string | null;
};

const statusOptionAliases: Record<TaskStatus, string[]> = {
  inbox: ["inbox", "backlog", "todo"],
  ready: ["ready", "todo", "backlog"],
  in_progress: ["in_progress", "in progress", "in-progress"],
  agent_review: ["agent_review", "agent review", "in_review", "in review", "review", "in progress"],
  human_review: ["human_review", "human review", "in_review", "in review", "review", "in progress"],
  blocked: ["blocked", "in progress"],
  done: ["done", "complete", "completed"],
};

function normalizedOptionName(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function issueStateForTaskStatus(status: TaskStatus): "open" | "closed" {
  return status === "done" ? "closed" : "open";
}

function findStatusOption(item: SyncedProjectItem, status: TaskStatus) {
  const aliases = new Set(statusOptionAliases[status].map(normalizedOptionName));
  return item.statusOptions.find((option) => aliases.has(normalizedOptionName(option.name))) ?? null;
}

function isMappedStatusOption(value: string | undefined) {
  if (!value) return false;
  const normalized = normalizedOptionName(value);
  return Object.values(statusOptionAliases).some((aliases) => aliases.some((alias) => normalizedOptionName(alias) === normalized));
}

export async function listProjectItems(project: Project): Promise<SyncedProjectItem[]> {
  if (!project.githubProjectId) throw new Error("This repository has no GitHub Projects V2 ID. Add it in the repository settings before syncing.");
  type ProjectField = { id: string; name?: string; options?: StatusOption[] };
  type ProjectItem = {
    id: string;
    content?: {
      __typename: string;
      id?: string;
      number?: number;
      title?: string;
      body?: string;
      state?: "OPEN" | "CLOSED";
      url?: string;
      repository?: { nameWithOwner: string };
      labels?: { nodes: Array<{ name: string }> };
    };
    fieldValues: { nodes: Array<{ field?: { id: string; name: string }; name?: string; optionId?: string }> };
  };
  type ProjectData = {
    node: {
      __typename: string;
      fields: { nodes: ProjectField[] };
      items: { nodes: ProjectItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } | null;
  };
  const items: ProjectItem[] = [];
  let cursor: string | null = null;
  let statusField: ProjectField | undefined;
  do {
    const data: ProjectData = await graphql<ProjectData>(`query ProjectItems($id: ID!, $after: String) {
      node(id: $id) {
        __typename
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
          items(first: 100, after: $after) {
            nodes {
              id
              content {
                __typename
                ... on Issue {
                  id
                  number
                  title
                  body
                  state
                  url
                  repository { nameWithOwner }
                  labels(first: 20) { nodes { name } }
                }
                ... on PullRequest {
                  id
                  number
                  title
                  url
                  repository { nameWithOwner }
                }
              }
              fieldValues(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    field { ... on ProjectV2SingleSelectField { id name } }
                    name
                    optionId
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { id: project.githubProjectId, after: cursor });
    if (!data.node) throw new Error(`GitHub Projects V2 project '${project.githubProjectId}' was not found or is not accessible to the configured token.`);
    if (data.node.__typename !== "ProjectV2") throw new Error(`GitHub node '${project.githubProjectId}' is not a Projects V2 project.`);
    statusField ??= data.node.fields.nodes.find((field: ProjectField) => field.name?.toLowerCase() === "status");
    items.push(...data.node.items.nodes);
    cursor = data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null;
    if (data.node.items.pageInfo.hasNextPage && !cursor) throw new Error("GitHub Projects V2 returned a page without a cursor.");
  } while (cursor);
  if (!statusField) throw new Error(`GitHub Projects V2 project '${project.githubProjectId}' has no usable Status field.`);
  return items.flatMap((item) => {
    if (!item.content || item.content.__typename !== "Issue" || !item.content.number) return [];
    if (item.content.repository?.nameWithOwner !== project.fullName) return [];
    const statusValue = item.fieldValues.nodes.find((value) => value.field?.id === statusField?.id);
    const statusOptions = statusField?.options ?? [];
    const statusOption = statusOptions.find((option) => option.id === statusValue?.optionId || option.name === statusValue?.name);
    return [{
      projectItemId: item.id,
      contentNodeId: item.content.id ?? null,
      statusFieldId: statusField?.id ?? null,
      statusOptionId: statusValue?.optionId ?? statusOption?.id ?? null,
      statusOptionName: statusValue?.name ?? statusOption?.name ?? null,
      statusMapped: isMappedStatusOption(statusValue?.name ?? statusOption?.name),
      statusOptions,
      issueNumber: item.content.number,
      issueState: item.content.state === "CLOSED" ? "closed" : "open",
      title: item.content.title ?? "Untitled issue",
      description: item.content.body ?? "",
      status: statusFromLabel(statusValue?.name),
      labels: item.content.labels?.nodes.map((label) => label.name.toLowerCase()) ?? [],
      githubUrl: item.content.url ?? null,
    }];
  });
}

export type CreatedIssue = { number: number; url: string; nodeId: string };

export async function ensureProjectItem(project: Project, issue: CreatedIssue) {
  const existing = (await listProjectItems(project)).find((item) => item.issueNumber === issue.number || item.contentNodeId === issue.nodeId);
  if (existing) return { projectChanged: false, item: existing };
  type AddProjectItemData = { addProjectV2ItemById: { item: { id: string } | null } };
  const data = await graphql<AddProjectItemData>(`mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }`, { projectId: project.githubProjectId, contentId: issue.nodeId });
  if (!data.addProjectV2ItemById.item?.id) throw new Error(`GitHub Projects V2 did not return an item for issue #${issue.number}.`);
  let item: SyncedProjectItem | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2500));
    item = (await listProjectItems(project)).find((candidate) => candidate.issueNumber === issue.number || candidate.contentNodeId === issue.nodeId);
    if (item) break;
  }
  if (!item) throw new Error(`Issue #${issue.number} was added remotely but could not be read back from GitHub Projects V2.`);
  return { projectChanged: true, item };
}

async function updateProjectItemStatus(project: Project, item: SyncedProjectItem, status: TaskStatus) {
  if (!project.githubProjectId || !item.statusFieldId) throw new Error("GitHub Projects V2 has no usable Status field for this item.");
  const option = findStatusOption(item, status);
  if (!option) throw new Error(`GitHub Projects V2 has no Status option mapped to '${status}' for issue #${item.issueNumber}.`);
  if (item.statusOptionId === option.id) return false;
  await graphql(`mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) { updateProjectV2ItemFieldValue(input:{ projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:{ singleSelectOptionId:$optionId } }) { projectV2Item { id } } }`, {
    projectId: project.githubProjectId,
    itemId: item.projectItemId,
    fieldId: item.statusFieldId,
    optionId: option.id,
  });
  return true;
}

async function updateIssueState(fullName: string, issueNumber: number, state: "open" | "closed") {
  const { owner, repo } = repoParts(fullName);
  const current = await readResponse(await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`));
  const currentState = current.state === "closed" ? "closed" : "open";
  if (currentState === state) return false;
  await readResponse(await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state, state_reason: state === "closed" ? "completed" : "reopened" }),
  }));
  return true;
}

export async function reconcileProjectItemLifecycle(project: Project, item: SyncedProjectItem) {
  if (!item.statusMapped) throw new Error(`GitHub Projects V2 Status option '${item.statusOptionName ?? "(empty)"}' for issue #${item.issueNumber} has no local workflow mapping.`);
  const issueChanged = await updateIssueState(project.fullName, item.issueNumber, issueStateForTaskStatus(item.status));
  return { issueChanged };
}

async function applyTaskStatus(project: Project, resolved: { issue: ResolvedIssue; created: boolean }, status: TaskStatus, originalTask?: Pick<Task, "issueNumber" | "githubUrl">) {
  const ensured = await ensureProjectItem(project, resolved.issue);
  const projectChanged = await updateProjectItemStatus(project, ensured.item, status);
  const issueChanged = await updateIssueState(project.fullName, resolved.issue.number, issueStateForTaskStatus(status));
  return {
    projectChanged,
    issueChanged,
    issueNumber: resolved.issue.number,
    githubUrl: resolved.issue.url,
    issueCreated: resolved.created,
    issueCorrected: originalTask ? originalTask.issueNumber !== resolved.issue.number || originalTask.githubUrl !== resolved.issue.url : false,
    projectItemAdded: ensured.projectChanged,
  };
}

export async function reconcileTaskStatus(project: Project, task: Pick<Task, "issueNumber" | "title" | "description" | "githubUrl">, status: TaskStatus) {
  return applyTaskStatus(project, await resolveTaskIssue(project, task), status, task);
}

export async function reconcileResolvedTaskStatus(project: Project, issue: ResolvedIssue, status: TaskStatus) {
  return applyTaskStatus(project, { issue, created: false }, status);
}

export async function createPullRequest(fullName: string, task: Task, run: AgentRun) {
  if (!task.issueNumber) throw new Error("Cannot create a pull request without a canonical GitHub Issue.");
  const { owner, repo } = repoParts(fullName);
  const head = run.branchName?.trim();
  const base = process.env.GITHUB_DEFAULT_BRANCH ?? "main";
  if (!head) throw new Error("Cannot create a pull request without a task branch.");
  const existing = await findOpenPullRequest(owner, repo, head, base);
  if (existing) return existing;

  const response = await githubRequest(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: task.title, head, base, body: `Fixes #${task.issueNumber}\n\n${task.currentSummary}\n\nCommit: ${run.commitSha ?? "not recorded"}` }) });
  if (response.status === 422) {
    const createdByRetry = await findOpenPullRequest(owner, repo, head, base);
    if (createdByRetry) return createdByRetry;
  }
  const body = await readResponse<PullRequestApiRecord>(response);
  const number = Number(body.number);
  const url = String(body.html_url ?? "");
  if (!Number.isInteger(number) || number <= 0 || !url) throw new Error("GitHub created the pull request but returned incomplete metadata.");
  return { url, number };
}

async function findOpenPullRequest(owner: string, repo: string, head: string, base: string): Promise<PullRequestReference | null> {
  const records = await readResponse<PullRequestApiRecord[]>(await githubRequest(`/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open&per_page=10`));
  const match = records.find((record) => Number.isInteger(Number(record.number)) && Number(record.number) > 0 && Boolean(record.html_url));
  if (!match) return null;
  return { number: Number(match.number), url: String(match.html_url) };
}

export async function publishComment(fullName: string, issueNumber: number, body: string) {
  const { owner, repo } = repoParts(fullName);
  await readResponse(await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) }));
}

export async function createIssue(fullName: string, title: string, body: string): Promise<CreatedIssue> {
  const { owner, repo } = repoParts(fullName);
  const result = await readResponse(await githubRequest(`/repos/${owner}/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) }));
  const nodeId = String(result.node_id ?? "");
  if (!nodeId) throw new Error("GitHub created the Issue but did not return its node ID for Projects V2 insertion.");
  const number = Number(result.number);
  const url = String(result.html_url ?? "");
  if (!Number.isInteger(number) || !url) throw new Error("GitHub created the Issue but returned incomplete identity metadata.");
  return { number, url, nodeId };
}

function normalizedIssueTitle(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function mapIssueRecord(record: IssueApiRecord): ResolvedIssue | null {
  if (record.pull_request || !record.number || !record.node_id || !record.html_url) return null;
  return {
    number: record.number,
    url: record.html_url,
    nodeId: record.node_id,
    title: record.title ?? "",
    body: record.body ?? "",
    state: record.state === "closed" ? "closed" : "open",
  };
}

async function getIssueByNumber(fullName: string, issueNumber: number): Promise<ResolvedIssue | null> {
  const { owner, repo } = repoParts(fullName);
  const response = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  if (response.status === 404) return null;
  return mapIssueRecord(await readResponse<IssueApiRecord>(response));
}

async function findIssueByTitle(fullName: string, title: string): Promise<ResolvedIssue | null> {
  const { owner, repo } = repoParts(fullName);
  const expectedTitle = normalizedIssueTitle(title);
  for (let page = 1; page <= 10; page += 1) {
    const records = await readResponse<IssueApiRecord[]>(await githubRequest(`/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`));
    const match = records.find((record) => !record.pull_request && normalizedIssueTitle(record.title ?? "") === expectedTitle);
    if (match) return mapIssueRecord(match);
    if (records.length < 100) break;
  }
  return null;
}

export async function resolveTaskIssue(project: Project, task: Pick<Task, "issueNumber" | "title" | "description" | "githubUrl">) {
  const numberedIssue = task.issueNumber ? await getIssueByNumber(project.fullName, task.issueNumber) : null;
  const numberedIssueMatches = numberedIssue
    && (task.githubUrl === numberedIssue.url || normalizedIssueTitle(task.title) === normalizedIssueTitle(numberedIssue.title));
  const issue = numberedIssueMatches ? numberedIssue : await findIssueByTitle(project.fullName, task.title);
  if (issue) return { issue, created: false };
  const created = await createIssue(project.fullName, task.title, task.description);
  return {
    issue: { ...created, title: task.title, body: task.description, state: "open" as const },
    created: true,
  };
}