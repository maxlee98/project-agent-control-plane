export const PR_TITLE_TYPES = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "build", "ci", "revert"] as const;
export type PrTitleType = (typeof PR_TITLE_TYPES)[number];

const supportedTypes = new Set<string>(PR_TITLE_TYPES);
const titlePattern = /^([a-z]+)(?:\([a-z0-9][a-z0-9._/-]*\))?!?:\s+\S.*$/i;
const labelAliases: Record<string, PrTitleType> = {
  bug: "fix",
  feature: "feat",
};

export function validatePrTitle(title: string): string[] {
  const errors: string[] = [];
  const normalized = title.trim();
  const match = normalized.match(titlePattern);

  if (!normalized) {
    errors.push("pull request title must not be empty");
  } else if (normalized.includes("\n") || normalized.includes("\r")) {
    errors.push("pull request title must be a single line");
  } else if (!match) {
    errors.push("pull request title must use '<type>: <description>' format");
  } else if (!supportedTypes.has(match[1]?.toLowerCase() ?? "")) {
    errors.push(`unsupported pull request title type '${match[1]}'`);
  }

  return errors;
}

export function assertValidPrTitle(title: string): void {
  const errors = validatePrTitle(title);
  if (errors.length) throw new Error(`Pull request title validation failed:\n- ${errors.join("\n- ")}`);
}

export function prTitleTypeFromLabels(labels: readonly string[]): PrTitleType {
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    if (supportedTypes.has(normalized)) return normalized as PrTitleType;
    if (labelAliases[normalized]) return labelAliases[normalized];
  }
  return "feat";
}

export function normalizePrTitle(title: string, labels: readonly string[] = []): string {
  const normalized = title.trim();
  if (validatePrTitle(normalized).length === 0) return normalized;
  if (!normalized || normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error("Cannot create a pull request without a single-line title description.");
  }
  return `${prTitleTypeFromLabels(labels)}: ${normalized}`;
}