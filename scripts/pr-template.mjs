import fs from "node:fs";

export function readTemplate(templatePath = ".github/pull_request_template.md") {
  return fs.readFileSync(templatePath, "utf8");
}

export function requiredHeadings(template) {
  return [...template.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1].trim());
}

const issueReferencePattern = /\b(?:Fixes|Closes)\s+#\d+\b/i;

export function validatePrBody(template, body) {
  const errors = [];
  for (const heading of requiredHeadings(template)) {
    if (!body.split(String.fromCharCode(10)).some((line) => line.trim() === `## ${heading}` || line.trim() === `### ${heading}`)) {
      errors.push(`missing heading: ${heading}`);
    }
  }
  if (body.includes("<!--")) errors.push("unresolved template comment remains");
  for (const command of ["npm test", "npm run typecheck", "npm run build", "git diff --check"]) {
    const validationMarker = `- [x] ${String.fromCharCode(96)}${command}${String.fromCharCode(96)}`;
    if (!body.includes(validationMarker)) errors.push(`validation result is not checked: ${command}`);
  }
  if (!/- \[x\] No `?\.env/.test(body)) errors.push("security secrets checklist is not checked");
  if (!body.includes("Not applicable")) errors.push("UX evidence needs evidence or an explicit Not applicable reason");
  if (!issueReferencePattern.test(body)) errors.push("explicit canonical GitHub Issue linkage is missing (use Fixes #<number> or Closes #<number>)");
  return errors;
}

export function assertValidPrBody(template, body) {
  const errors = validatePrBody(template, body);
  if (errors.length) throw new Error(`PR template validation failed:\n- ${errors.join("\n- ")}`);
}