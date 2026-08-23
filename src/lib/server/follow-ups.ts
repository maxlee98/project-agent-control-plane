import { randomUUID } from "node:crypto";
import { ClineCore } from "@cline/sdk";
import type { FollowUpCreationOutcome, FollowUpProposal, Project, Task, TaskPriority } from "../domain";
import { isTaskPriority } from "../domain";
import { ApiRequestError, API_LIMITS } from "./api";
import { createIssue, reconcileTaskStatus } from "./github";
import { addActivity, createTask, getTaskActivity } from "./repository";
import { redactSecrets } from "./redaction";

export type FollowUpRecommendationInput = Pick<FollowUpProposal, "title" | "rationale" | "priority" | "description" | "acceptanceCriteria"> & Partial<Pick<FollowUpProposal, "origin" | "id">>;

export interface FollowUpRecommendationDependencies {
  recommend?: (prompt: string) => Promise<string>;
}

export interface FollowUpCreationDependencies {
  createIssue?: typeof createIssue;
  reconcileTaskStatus?: typeof reconcileTaskStatus;
}

const recommendationSystemPrompt = "You suggest concise follow-up work for a software task. Return only JSON with a proposals array. Do not include secrets, credentials, session IDs, arbitrary logs, or markdown outside the JSON.";
const DEFAULT_RECOMMENDATION_TIMEOUT_MS = 60_000;

function bounded(value: string | null | undefined, limit: number) {
  const redacted = redactSecrets(value?.trim()) ?? "";
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function recommendationTimeoutMs() {
  const configured = Number(process.env.FOLLOW_UP_RECOMMENDATION_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(120_000, configured)) : DEFAULT_RECOMMENDATION_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Follow-up recommendation timed out.")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function proposalText(value: unknown, field: string, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new ApiRequestError("INVALID_PROPOSAL", `${field} must be a non-empty string of at most ${limit} characters.`, 400, { field, maxLength: limit });
  }
  return bounded(value, limit);
}

export function normalizeFollowUpProposal(value: unknown, index = 0, origin: FollowUpProposal["origin"] = "generated"): FollowUpProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError("INVALID_PROPOSAL", `Proposal ${index + 1} must be an object.`, 400, { field: "proposals" });
  const input = value as Record<string, unknown>;
  const criteria = input.acceptanceCriteria;
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > API_LIMITS.followUpAcceptanceCriteria || criteria.some((item) => typeof item !== "string" || !item.trim() || item.length > API_LIMITS.followUpAcceptanceCriterion)) {
    throw new ApiRequestError("INVALID_PROPOSAL", `Proposal ${index + 1} acceptanceCriteria must contain 1-${API_LIMITS.followUpAcceptanceCriteria} strings of at most ${API_LIMITS.followUpAcceptanceCriterion} characters.`, 400, { field: "acceptanceCriteria", maxItems: API_LIMITS.followUpAcceptanceCriteria, maxLength: API_LIMITS.followUpAcceptanceCriterion });
  }
  const priority = input.priority;
  if (!isTaskPriority(priority)) throw new ApiRequestError("INVALID_PROPOSAL", `Proposal ${index + 1} priority must be an integer from 1 to 4.`, 400, { field: "priority", min: 1, max: 4 });
  const inputOrigin = input.origin === undefined ? origin : input.origin;
  if (inputOrigin !== "generated" && inputOrigin !== "manual") throw new ApiRequestError("INVALID_PROPOSAL", `Proposal ${index + 1} origin is invalid.`, 400, { field: "origin", allowed: ["generated", "manual"] });
  const id = input.id === undefined ? `proposal-${randomUUID()}` : proposalText(input.id, "id", API_LIMITS.identifier);
  return {
    id,
    origin: inputOrigin,
    title: proposalText(input.title, "title", API_LIMITS.followUpTitle),
    rationale: proposalText(input.rationale, "rationale", API_LIMITS.followUpRationale),
    priority,
    description: proposalText(input.description, "description", API_LIMITS.followUpDescription),
    acceptanceCriteria: criteria.map((item) => bounded(item as string, API_LIMITS.followUpAcceptanceCriterion)),
  };
}

export function normalizeFollowUpProposals(value: unknown, max: number = API_LIMITS.followUpProposals) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new ApiRequestError("INVALID_PROPOSALS", `proposals must contain 1-${max} items.`, 400, { field: "proposals", maxItems: max });
  }
  const ids = new Set<string>();
  return value.map((proposal, index) => {
    const normalized = normalizeFollowUpProposal(proposal, index);
    if (ids.has(normalized.id)) throw new ApiRequestError("INVALID_PROPOSALS", "Proposal IDs must be unique.", 400, { field: "proposals" });
    ids.add(normalized.id);
    return normalized;
  });
}

function fallbackProposals(task: Task, max: number) {
  const context = bounded(task.currentSummary || task.description, 700);
  const candidates: FollowUpRecommendationInput[] = [
    {
      origin: "generated",
      title: `Add regression coverage for ${task.title}`,
      rationale: "Lock the resolved behavior into focused automated coverage so adjacent changes do not reintroduce the issue.",
      priority: task.priority,
      description: `Add focused tests around the behavior resolved by “${bounded(task.title, 180)}”. Use the existing test conventions and preserve the useful task context: ${context || "Review the completed change and identify the smallest stable contract to exercise."}`,
      acceptanceCriteria: ["Add focused coverage for the resolved behavior.", "Cover the most important failure or edge case.", "Run the focused test and the project test suite."],
    },
    {
      origin: "generated",
      title: `Document the follow-up path for ${task.title}`,
      rationale: "Make the completed work easier to operate and extend by capturing the decisions and remaining boundary conditions.",
      priority: Math.min(4, task.priority + 1) as TaskPriority,
      description: `Capture the user-visible behavior, operational notes, and remaining limitations from “${bounded(task.title, 180)}” in the repository's existing documentation surface.`,
      acceptanceCriteria: ["Document the behavior and relevant usage path.", "Record constraints or recovery guidance.", "Keep the documentation aligned with the implemented behavior."],
    },
  ];
  return candidates.slice(0, max).map((candidate, index) => normalizeFollowUpProposal({ ...candidate, id: `generated-${index + 1}` }, index));
}

function recommendationPrompt(task: Task, project: Project, max: number) {
  const activities = getTaskActivity(task.id, 8).map((item) => `${bounded(item.title, 180)}${item.detail ? ` — ${bounded(item.detail, 500)}` : ""}`).join("\n");
  return `${recommendationSystemPrompt}\n\nRepository: ${bounded(project.fullName, 200)}\nResolved task title: ${bounded(task.title, API_LIMITS.taskTitle)}\nResolved task description: ${bounded(task.description, 2_000)}\nLatest task summary: ${bounded(task.currentSummary, 1_000)}\nRecent activity:\n${activities || "None"}\n\nSuggest at most ${max} distinct, actionable follow-ups. Each item must include title, rationale, priority (1-4), description, and 1-3 acceptanceCriteria strings. Do not suggest changing or redoing the resolved task.`;
}

function parseRecommendationText(text: string, max: number) {
  const cleaned = bounded(text, 20_000).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Recommendation response was not valid JSON.");
    try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { throw new Error("Recommendation response was not valid JSON."); }
  }
  const proposals = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { proposals?: unknown }).proposals : null;
  const generatedInput = Array.isArray(proposals) ? proposals.map((proposal) => {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return proposal;
    const { id: _id, origin: _origin, ...fields } = proposal as Record<string, unknown>;
    return fields;
  }) : proposals;
  return normalizeFollowUpProposals(generatedInput, max as number).map((proposal, index) => ({ ...proposal, id: `generated-${index + 1}`, origin: "generated" as const }));
}

async function runClineRecommendation(prompt: string) {
  type CreateOptions = Parameters<typeof ClineCore.create>[0];
  const cline = await ClineCore.create({ clientName: "project-agent-control-plane", backendMode: "local" } as CreateOptions);
  let sessionId = "";
  try {
    const result = await withTimeout(cline.start({ source: "cli", mode: "automation", interactive: false, config: {
      providerId: process.env.CLINE_PROVIDER_ID ?? "anthropic",
      modelId: process.env.CLINE_MODEL_ID ?? "claude-sonnet-4-5",
      apiKey: process.env.CLINE_API_KEY,
      systemPrompt: recommendationSystemPrompt,
      cwd: process.cwd(),
      enableTools: false,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      yolo: false,
    } }), recommendationTimeoutMs());
    sessionId = result.sessionId.trim();
    if (!sessionId) throw new Error("Recommendation session did not start.");
    const response = await withTimeout(cline.send({ sessionId, prompt, mode: "act" }), recommendationTimeoutMs());
    if (!response?.text) throw new Error("Recommendation session returned no proposals.");
    return response.text;
  } finally {
    if (sessionId) await cline.stop(sessionId).catch(() => undefined);
    await cline.dispose().catch(() => undefined);
  }
}

export async function recommendFollowUps(task: Task, project: Project, max: number, dependencies: FollowUpRecommendationDependencies = {}) {
  if (process.env.EXECUTION_MODE !== "live") return fallbackProposals(task, max);
  const recommend = dependencies.recommend ?? runClineRecommendation;
  const text = await recommend(recommendationPrompt(task, project, max));
  return parseRecommendationText(text, max);
}

function issueBody(proposal: FollowUpProposal) {
  return [
    "## Summary",
    "",
    proposal.title.trim(),
    "",
    "## Context and evidence",
    "",
    "This follow-up was proposed during review of a resolved control-plane task.",
    "",
    "## Problem",
    "",
    proposal.description.trim(),
    "",
    "## Goals and non-goals",
    "",
    "### Goals",
    "",
    `- ${proposal.rationale.trim()}`,
    "",
    "### Non-goals",
    "",
    "- Do not alter the resolved source task.",
    "",
    "## Acceptance criteria",
    "",
    proposal.acceptanceCriteria.map((criterion) => `- ${criterion.trim()}`).join("\n"),
    "",
    "## Affected areas",
    "",
    "Review the repository/task context before implementation.",
    "",
    "## Validation",
    "",
    "Run the focused checks and the repository validation commands.",
    "",
    "## Risks and rollback",
    "",
    "Keep the change focused and revert the branch if validation or review identifies a regression.",
    "",
    "## Follow-up questions",
    "",
    "None blocking.",
  ].join("\n");
}

export async function createSelectedFollowUps(task: Task, project: Project, proposals: FollowUpProposal[], dependencies: FollowUpCreationDependencies = {}): Promise<FollowUpCreationOutcome[]> {
  const createRemoteIssue = dependencies.createIssue ?? createIssue;
  const reconcile = dependencies.reconcileTaskStatus ?? reconcileTaskStatus;
  const outcomes: FollowUpCreationOutcome[] = [];
  for (const proposal of proposals) {
    try {
      const body = issueBody(proposal);
      if (process.env.EXECUTION_MODE === "live") {
        if (!project.githubProjectId) throw new Error("This repository has no configured Projects V2 board.");
        const issue = await createRemoteIssue(project.fullName, proposal.title, body, proposal.priority);
        await reconcile(project, { issueNumber: issue.number, title: proposal.title, description: body, githubUrl: issue.url, priority: proposal.priority }, "inbox");
        const created = createTask({ projectId: project.id, title: proposal.title, description: body, priority: proposal.priority, issueNumber: issue.number, githubUrl: issue.url });
        if (!created) throw new Error("The created Issue could not be linked to a local task.");
        addActivity({ projectId: task.projectId, taskId: task.id, type: "follow_up_created", title: "Follow-up Issue created", detail: `${proposal.title} · #${issue.number}`, tone: "green" });
        outcomes.push({ proposalId: proposal.id, title: proposal.title, result: "created", taskId: created.id, issueNumber: issue.number, githubUrl: issue.url, message: `Created Issue #${issue.number} and added it to Projects V2.` });
      } else {
        const created = createTask({ projectId: project.id, title: proposal.title, description: body, priority: proposal.priority });
        if (!created) throw new Error("The local task could not be created.");
        addActivity({ projectId: task.projectId, taskId: task.id, type: "follow_up_created", title: "Follow-up task created", detail: proposal.title, tone: "green" });
        outcomes.push({ proposalId: proposal.id, title: proposal.title, result: "created", taskId: created.id, message: "Created local Inbox task; no GitHub request was made." });
      }
    } catch (error) {
      const message = "Could not create this follow-up. Check the connection and retry.";
      addActivity({ projectId: task.projectId, taskId: task.id, type: "follow_up_creation_failed", title: "Follow-up creation failed", detail: `${proposal.title} · ${message}`, tone: "red" });
      outcomes.push({ proposalId: proposal.id, title: proposal.title, result: "failed", message });
    }
  }
  return outcomes;
}

export function recommendationActivityDetail(count: number) {
  return `Prepared ${count} follow-up proposal${count === 1 ? "" : "s"} for operator review.`;
}