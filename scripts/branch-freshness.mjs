export function freshnessErrors(comparison, base, head) {
  const errors = [];
  if (comparison.status === "diverged") errors.push(`${head} diverged from ${base}`);
  if (Number(comparison.behind_by) > 0) errors.push(`${head} is ${comparison.behind_by} commit(s) behind ${base}`);
  return errors;
}

export function assertFreshComparison(comparison, base, head) {
  const errors = freshnessErrors(comparison, base, head);
  if (errors.length) throw new Error(`branch freshness check failed: ${errors.join("; ")}. Update the branch or rebase it onto origin/${base} before creating the PR.`);
}