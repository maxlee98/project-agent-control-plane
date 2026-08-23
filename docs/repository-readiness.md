# Repository readiness

Adding a repository only registers its GitHub name and local checkout. It does not edit the target
checkout, install dependencies, create branches, or open pull requests. Use **Check now** on the
dashboard (or select it during registration) to run the non-mutating readiness assessment.

All managed Issues use the dashboard's canonical priority vocabulary: `P0`, `P1`, `P2`, and `P3`.
Live readiness requires the target GitHub Projects V2 board to expose exactly one single-select
`Priority` field with exactly those four options. The same value must be present on the Project item
before a synchronized Issue is reported successful; readiness does not use or create GitHub labels for
this contract.

Each report includes a contract version, check timestamp, overall level, category counts, safe
remediation, and a baseline summary:

- **Registered** — the configured checkout cannot be inspected.
- **Inspectable** — the checkout is readable, but one or more policy, validation, or Live checks need
  attention.
- **Demo-ready** — the checkout can be explored in Demo mode; Live-only requirements may still be
  unresolved.
- **Live-ready** — required checkout, worktree, policy, validation, runtime, GitHub Project, and
  handoff checks passed.

Readiness never runs repository-defined commands. It only reads bounded metadata and detects the
explicit validation commands supported by the control plane. Credential checks report presence only;
tokens, environment contents, command output, and provider responses are not included in reports.

## Baseline via pull request

If `WORKFLOW.md` or `.github/pull_request_template.md` is missing, the report offers **Create
baseline via PR**. This approved action copies only the missing control-plane baseline files into a
temporary isolated worktree, commits them on a dedicated branch, pushes that branch, and opens a
summary pull request. It never edits the configured checkout directly and never merges automatically.

## Project status contract

Live synchronization requires one unambiguous GitHub Projects V2 Status option for each canonical
concept: `Ready`, `In progress`, `Review`, `Blocked`, and `Done`. Case, spacing, and hyphen aliases
are normalized, but duplicate matches are reported as ambiguous and block Live synchronization.
Priority names are intentionally exact: extra, missing, duplicate, or differently named options fail
readiness with an actionable remediation.