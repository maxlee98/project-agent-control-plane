const SENSITIVE_ENV_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|CREDENTIAL)/i;

function configuredSecretValues() {
  return Object.entries(process.env)
    .filter(([key, value]) => SENSITIVE_ENV_KEY.test(key) && Boolean(value) && String(value).length >= 8)
    .map(([, value]) => String(value))
    .sort((left, right) => right.length - left.length);
}

/** Redacts provider credentials before agent output reaches SQLite, the UI, or GitHub comments. */
export function redactSecrets(value: string | null | undefined) {
  if (value == null) return value ?? null;
  let output = String(value);

  for (const secret of configuredSecretValues()) {
    output = output.split(secret).join("[REDACTED_SECRET]");
  }

  output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED_TOKEN]");
  output = output.replace(
    /(["']?(?:api[_-]?key|token|secret|password|authorization|private[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    "$1[REDACTED_SECRET]",
  );

  return output;
}