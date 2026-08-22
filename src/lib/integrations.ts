import type { AgentRun, Project, ReasoningEffort, Task } from "./domain";

/**
 * Stable boundary between the control plane and GitHub Projects V2.
 * The UI and scheduler should only depend on these normalized operations.
 */
export interface ProjectTracker {
  validateRepository(fullName: string): Promise<{ ok: boolean; reason?: string }>;
  listProjectItems(project: Project): Promise<Task[]>;
  createIssue(project: Project, input: { title: string; body: string }): Promise<Task>;
  updateIssue(task: Task, input: { title?: string; body?: string; comment?: string }): Promise<void>;
  moveItem(task: Task, status: Task["status"]): Promise<void>;
  publishCheckpoint(task: Task, run: AgentRun, summary: string): Promise<void>;
  createOrUpdatePullRequest(task: Task, run: AgentRun): Promise<{ url: string }>;
}

/**
 * This adapter is deliberately not called by demo-mode routes yet. It documents the seam where
 * GitHub REST/GraphQL calls should live and prevents GitHub-specific IDs leaking into the domain.
 */
export class GitHubProjectsAdapter implements ProjectTracker {
  async validateRepository() { return { ok: false, reason: "GitHub adapter is not enabled in demo mode." }; }
  async listProjectItems() { return []; }
  async createIssue(_project: Project, _input: { title: string; body: string }): Promise<Task> { throw new Error("GitHub adapter is not enabled in demo mode."); }
  async updateIssue() { return undefined; }
  async moveItem() { return undefined; }
  async publishCheckpoint() { return undefined; }
  async createOrUpdatePullRequest(_task: Task, _run: AgentRun): Promise<{ url: string }> { throw new Error("GitHub adapter is not enabled in demo mode."); }
}

export interface AgentRunInput {
  task: Task;
  project: Project;
  prompt: string;
  workspacePath: string;
  reasoningEffort?: ReasoningEffort | null;
}

export interface AgentHandle {
  runId: string;
  sessionId: string;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentRunner {
  start(input: AgentRunInput): Promise<AgentHandle>;
  continue(input: AgentRunInput & { sessionId: string }): Promise<AgentHandle>;
}

/** ClineCore is wired here after local worktree and credential policy are configured. */
export class ClineAgentRunner implements AgentRunner {
  async start(_input: AgentRunInput): Promise<AgentHandle> { throw new Error("Cline adapter is not enabled in demo mode."); }
  async continue(_input: AgentRunInput & { sessionId: string }): Promise<AgentHandle> { throw new Error("Cline adapter is not enabled in demo mode."); }
}