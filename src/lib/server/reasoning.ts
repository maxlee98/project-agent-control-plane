import { Llms } from "@cline/sdk";
import { isReasoningEffort, type ReasoningCapability, type ReasoningEffort } from "../domain";

const effortOrder: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function capabilityFromModel(providerId: string, modelId: string, model: { reasoningOptions?: readonly unknown[] } | undefined): ReasoningCapability {
  const supported = new Set<ReasoningEffort>();
  for (const option of model?.reasoningOptions ?? []) {
    if (!option || typeof option !== "object" || (option as { type?: unknown }).type !== "effort") continue;
    const values = (option as { values?: unknown }).values;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (isReasoningEffort(value)) supported.add(value);
    }
  }
  return { providerId, modelId, supportedEfforts: effortOrder.filter((effort) => supported.has(effort)) };
}

export async function getReasoningCapability(providerId: string, modelId: string): Promise<ReasoningCapability> {
  const models = await Llms.getModelsForProvider(providerId);
  return capabilityFromModel(providerId, modelId, models[modelId] as { reasoningOptions?: readonly unknown[] } | undefined);
}

export function getReasoningCapabilitySync(providerId: string, modelId: string): ReasoningCapability {
  try {
    const collection = Llms.getProviderCollectionSync(providerId);
    return capabilityFromModel(providerId, modelId, collection?.models[modelId] as { reasoningOptions?: readonly unknown[] } | undefined);
  } catch {
    return { providerId, modelId, supportedEfforts: [] };
  }
}

export async function getConfiguredReasoningCapability(): Promise<ReasoningCapability> {
  return getReasoningCapability(process.env.CLINE_PROVIDER_ID ?? "anthropic", process.env.CLINE_MODEL_ID ?? "claude-sonnet-4-5");
}

export async function validateReasoningEffort(providerId: string, modelId: string, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (!isReasoningEffort(value)) throw new Error("Reasoning effort must be one of the supported effort values.");
  const capability = await getReasoningCapability(providerId, modelId);
  if (!capability.supportedEfforts.includes(value)) throw new Error(`Reasoning effort '${value}' is not supported by ${providerId}/${modelId}.`);
  return value;
}

export function validateReasoningEffortSync(providerId: string, modelId: string, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (!isReasoningEffort(value)) throw new Error("Reasoning effort must be one of the supported effort values.");
  const capability = getReasoningCapabilitySync(providerId, modelId);
  if (!capability.supportedEfforts.includes(value)) throw new Error(`Reasoning effort '${value}' is not supported by ${providerId}/${modelId}.`);
  return value;
}
