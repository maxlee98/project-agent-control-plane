export function parseEstimatedCostCents(value: unknown) {
  if (value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const text = typeof value === "string" ? value.trim() : String(value);
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}