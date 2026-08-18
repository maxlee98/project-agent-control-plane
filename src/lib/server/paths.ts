import os from "node:os";
import path from "node:path";

export function normalizeLocalPath(value: string) {
  const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}