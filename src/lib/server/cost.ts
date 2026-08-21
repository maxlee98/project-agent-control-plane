import { Llms } from "@cline/sdk";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost?: number;
}

export interface RunUsageSnapshot extends UsageTotals {
  providerId: string;
  modelId: string;
  actualCostUsd: number | null;
  costSource: "sdk" | "catalog" | "unavailable";
}

export function parseEstimatedCostCents(value: unknown) {
  if (value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const text = typeof value === "string" ? value.trim() : String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = match[2] ?? "";
  const cents = whole * BigInt(100) + BigInt((fraction + "00").slice(0, 2)) + (fraction[2] && fraction[2] >= "5" ? BigInt(1) : BigInt(0));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function nonNegativeCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export function calculateCatalogCostUsd(usage: UsageTotals, pricing: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined) {
  if (!pricing || pricing.input === undefined || pricing.output === undefined) return null;
  if (usage.cacheReadTokens > 0 && pricing.cacheRead === undefined) return null;
  if (usage.cacheWriteTokens > 0 && pricing.cacheWrite === undefined) return null;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const total = uncachedInputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * (pricing.cacheRead ?? 0)
    + usage.cacheWriteTokens * (pricing.cacheWrite ?? 0);
  return Number.isFinite(total) && total >= 0 ? Number((total / 1_000_000).toFixed(6)) : null;
}

export async function readRunUsage(providerId: string, modelId: string, usage: Partial<UsageTotals> | undefined): Promise<RunUsageSnapshot | null> {
  if (!usage) return null;
  const totals: UsageTotals = {
    inputTokens: nonNegativeCount(usage.inputTokens),
    outputTokens: nonNegativeCount(usage.outputTokens),
    cacheReadTokens: nonNegativeCount(usage.cacheReadTokens),
    cacheWriteTokens: nonNegativeCount(usage.cacheWriteTokens),
    totalCost: Number.isFinite(usage.totalCost) && Number(usage.totalCost) >= 0 ? Number(usage.totalCost) : undefined,
  };
  if (totals.totalCost !== undefined) return { providerId, modelId, ...totals, actualCostUsd: totals.totalCost, costSource: "sdk" };

  const models = await Llms.getModelsForProvider(providerId);
  const catalogCost = calculateCatalogCostUsd(totals, models[modelId]?.pricing);
  return { providerId, modelId, ...totals, actualCostUsd: catalogCost, costSource: catalogCost === null ? "unavailable" : "catalog" };
}