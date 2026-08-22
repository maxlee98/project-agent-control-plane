import { createHash } from "node:crypto";

export const API_LIMITS = {
  bodyBytes: 64 * 1024,
  identifier: 128,
  idempotencyKey: 128,
  repository: 200,
  path: 4_096,
  projectDescription: 4_000,
  taskTitle: 200,
  taskDescription: 12_000,
  comment: 12_000,
  label: 50,
  labels: 20,
  estimatedCostCents: 100_000_000,
} as const;

export type ApiDetails = Record<string, boolean | number | string | string[]>;

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: ApiDetails;

  constructor(code: string, message: string, status: number, details?: ApiDetails) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const SAFE_DETAIL_KEYS = new Set(["field", "maxBytes", "maxLength", "maxItems", "min", "max", "allowed"]);

function safeDetails(details: ApiDetails) {
  const output: ApiDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "string" && value.length <= API_LIMITS.identifier) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, API_LIMITS.identifier));
  }
  return output;
}

export function apiError(code: string, message: string, status: number, details?: ApiDetails) {
  const sanitizedDetails = details ? safeDetails(details) : undefined;
  return Response.json({ code, message, ...(sanitizedDetails && Object.keys(sanitizedDetails).length ? { details: sanitizedDetails } : {}) }, { status });
}

export function apiErrorFrom(error: unknown, fallback = "The request could not be completed.") {
  if (error instanceof ApiRequestError) return apiError(error.code, error.message, error.status, error.details);
  return apiError("INTERNAL_ERROR", fallback, 500);
}

export function apiResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

async function readBoundedBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > API_LIMITS.bodyBytes) {
    throw new ApiRequestError("PAYLOAD_TOO_LARGE", "Request body exceeds the 64 KiB limit.", 413, { maxBytes: API_LIMITS.bodyBytes });
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > API_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new ApiRequestError("PAYLOAD_TOO_LARGE", "Request body exceeds the 64 KiB limit.", 413, { maxBytes: API_LIMITS.bodyBytes });
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function parseJsonBody(request: Request, options: { allowEmpty?: boolean } = {}) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiRequestError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", 415);
  }

  const bytes = await readBoundedBody(request);
  if (bytes.byteLength === 0 && options.allowEmpty) return {} as Record<string, unknown>;
  if (bytes.byteLength === 0) throw new ApiRequestError("INVALID_JSON", "Request body must contain a JSON object.", 400);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiRequestError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new ApiRequestError("INVALID_JSON", "Request body must be a JSON object.", 400);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertAllowedKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ApiRequestError("VALIDATION_ERROR", "Request contains unsupported fields.", 400, { field: unknown[0] });
}

export function requiredString(body: Record<string, unknown>, field: string, maxLength: number) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ApiRequestError("VALIDATION_ERROR", `${field} must be a non-empty string of at most ${maxLength} characters.`, 400, { field, maxLength });
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength: number) {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ApiRequestError("VALIDATION_ERROR", `${field} must be a string of at most ${maxLength} characters.`, 400, { field, maxLength });
  }
  return value.trim();
}

export function optionalNonEmptyString(body: Record<string, unknown>, field: string, maxLength: number) {
  const value = optionalString(body, field, maxLength);
  if (value !== undefined && !value) {
    throw new ApiRequestError("VALIDATION_ERROR", `${field} must not be empty.`, 400, { field });
  }
  return value;
}

export function optionalNullableString(body: Record<string, unknown>, field: string, maxLength: number) {
  const value = body[field];
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ApiRequestError("VALIDATION_ERROR", `${field} must be a string of at most ${maxLength} characters.`, 400, { field, maxLength });
  }
  return value.trim();
}

export function optionalInteger(body: Record<string, unknown>, field: string, min: number, max: number) {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ApiRequestError("VALIDATION_ERROR", `${field} must be an integer between ${min} and ${max}.`, 400, { field, min, max });
  }
  return Number(value);
}

export function optionalEnum<T extends string>(body: Record<string, unknown>, field: string, values: readonly T[]) {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ApiRequestError("INVALID_ENUM", `${field} must be one of the supported values.`, 400, { field, allowed: [...values] });
  }
  return value as T;
}

export function optionalStringArray(body: Record<string, unknown>, field: string, maxItems: number, maxItemLength: number) {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.trim().length === 0 || item.length > maxItemLength)) {
    throw new ApiRequestError("VALIDATION_ERROR", `${field} must contain at most ${maxItems} strings of at most ${maxItemLength} characters.`, 400, { field, maxItems, maxItemLength });
  }
  return value.map((item) => String(item).trim());
}

export function validateIdentifier(value: string, field: string) {
  if (value.length > API_LIMITS.identifier || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new ApiRequestError("INVALID_IDENTIFIER", `${field} is not a valid identifier.`, 400, { field });
  }
  return value;
}

export function validateRepository(value: string) {
  if (value.length > API_LIMITS.repository || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(value)) {
    throw new ApiRequestError("INVALID_REPOSITORY", "fullName must use the owner/repository format.", 400, { field: "fullName" });
  }
  return value;
}

export function validateProjectNodeId(value: string) {
  if (!/^PVT_[A-Za-z0-9]+$/.test(value)) {
    throw new ApiRequestError("INVALID_IDENTIFIER", "githubProjectId must be a Projects V2 node ID.", 400, { field: "githubProjectId" });
  }
  return value;
}

export function validatePath(value: string) {
  if (value.length > API_LIMITS.path || /[\u0000\r\n]/.test(value)) {
    throw new ApiRequestError("VALIDATION_ERROR", "localPath is too long or contains invalid characters.", 400, { field: "localPath", maxLength: API_LIMITS.path });
  }
  return value;
}

export function getIdempotencyKey(request: Request, required = true) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key && required) throw new ApiRequestError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required for this mutation.", 400);
  if (!key) return null;
  if (key.length > API_LIMITS.idempotencyKey || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ApiRequestError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key contains unsupported characters or is too long.", 400, { maxLength: API_LIMITS.idempotencyKey });
  }
  return key;
}

export function requestFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function idempotencyResponse(claim: { kind: "conflict" | "in_progress" }) {
  return apiError(
    claim.kind === "conflict" ? "IDEMPOTENCY_CONFLICT" : "IDEMPOTENCY_IN_PROGRESS",
    claim.kind === "conflict" ? "Idempotency-Key was already used for a different request." : "An earlier request with this Idempotency-Key is still being completed; do not repeat the remote operation.",
    409,
  );
}