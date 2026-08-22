export const PR_TITLE_TYPES = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "build", "ci", "revert"];

const supportedTypes = new Set(PR_TITLE_TYPES);
const titlePattern = /^([a-z]+)(?:\([a-z0-9][a-z0-9._/-]*\))?!?:\s+\S.*$/i;

export function validatePrTitle(title) {
  const errors = [];
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

export function assertValidPrTitle(title) {
  const errors = validatePrTitle(title);
  if (errors.length) throw new Error(`Pull request title validation failed:\n- ${errors.join("\n- ")}`);
}