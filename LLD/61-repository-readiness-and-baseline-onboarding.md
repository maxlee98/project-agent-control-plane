# LLD: Repository readiness and baseline onboarding

## Status
- Status: Complete
- Owner: Project Agent Control Plane
- Date: 2025-02-14
- Related task or issue: GitHub Issue #61

## Problem
Registered repositories currently appear usable even when their checkout, policy, validation,
runtime, GitHub, or Project configuration cannot support a safe Live run. The Add repository flow
also has no explicit, non-mutating onboarding assessment or baseline-via-PR path.

## Goals
- Provide a safe, structured readiness assessment for a registered repository.
- Distinguish registered, inspectable, Demo-ready, and Live-ready states.
- Detect local checkout/Git/worktree, policy, skills, validation, runtime, GitHub, Project status,
  and PR/handoff prerequisites without exposing secrets or executing untrusted commands.
- Persist the latest report for the dashboard and gate Live dispatch with a fresh required check.
- Present missing policy/template files as an explicit baseline pull-request proposal.

## Non-goals
- Do not mutate a target checkout during readiness checks.
- Do not install dependencies, execute arbitrary repository scripts, or automatically create/merge PRs.
- Do not redesign GitHub Projects or replace repository-specific conventions.

## Requirements and acceptance criteria
- Readiness is user-triggered from onboarding/dashboard and returns timestamp, contract version,
  overall level, category summaries, checks, and safe remediation.
- Demo remains available when Live-only checks fail.
- Live is blocked by unresolved required checks and rechecks immediately before dispatch.
- Project statuses map explicitly to Ready, In progress, Review, Blocked, and Done; missing or
  ambiguous mappings are visible.
- Baseline preparation is branch-and-PR first and never silently changes the checkout.

## Existing architecture
Next.js route handlers call `src/lib/server/repository.ts`, which maps SQLite project/task/run
state. `workspaces.ts` owns isolated Git worktrees, `validation.ts` detects safe checks,
`github.ts` owns GitHub adapters, and `orchestrator.ts` controls Live dispatch. The React dashboard
is in `ControlPlane.tsx`; `domain.ts` contains API-facing types.

## Proposed design
Add a pure readiness domain contract and server assessment service. Local inspection uses bounded
Git commands and filesystem metadata only. Validation uses the existing explicit allowlist detector.
Runtime checks inspect configuration presence only. GitHub readiness is adapter-backed and maps
canonical status concepts by normalized unique aliases. Reports are stored as a JSON snapshot on the
project, exposed through a project readiness route, and consumed by the dashboard and Live preflight.
Baseline support starts as an explicit proposal response; target mutations and PR creation remain a
separate approved action boundary.

## Data and state transitions
`registered -> inspectable -> demo_ready -> live_ready` is derived from report checks, while
`unknown` is used when inspection cannot establish a fact. A report is generated on demand, cached
on the project, and invalidated by repository configuration changes. Live dispatch requires a fresh
report with no required blocker/unknown result; Demo dispatch ignores Live-only failures.

Demo readiness is intentionally independent of Live-only credentials and GitHub status checks; a
usable checkout with only those Live blockers remains inspectable/demo-available while the dashboard
shows the unresolved remediation.

## Affected files and boundaries
- `src/lib/domain.ts`: readiness levels, checks, status mapping, dashboard contract.
- `src/lib/server/readiness.ts`: bounded local/configuration assessment and redaction.
- `src/lib/server/db.ts`, `repository.ts`: report persistence and project mapping.
- `src/lib/server/workspaces.ts`, `github.ts`: inspection seams and status capability mapping.
- `src/app/api/projects/[projectId]/readiness/route.ts`: user-triggered report endpoint.
- `src/lib/server/orchestrator.ts`: Live preflight gate.
- `src/components/ControlPlane.tsx`: readiness card and remediation.
- `tests/readiness.test.ts`: focused missing-checkout, valid-checkout, validation detection, and
  redaction coverage.
- `docs/repository-readiness.md`: operator onboarding and status-contract documentation.

## Risks, edge cases, and rollback
Unusual Git remotes, detached branches, repositories without automated checks, and GitHub Projects
with duplicate aliases are conservatively classified. Reports never include command output, tokens,
or environment values. The feature can be rolled back by removing report persistence and the preflight
call; no destructive migration is required.

## Validation plan
- Unit tests for valid/missing/invalid checkout and remote, policy/template/skills detection,
  validation detection, status alias ambiguity, redaction, and readiness levels.
- Existing focused test suite, typecheck, production build, and whitespace validation.

## Decision log
- 2025-02-14: Use a stored JSON snapshot rather than a new normalized table to avoid a migration for
  an inspectable cache and preserve safe report shape.
- 2025-02-14: Treat missing automated checks as a Live blocker while retaining Demo readiness.
- 2025-02-14: Keep baseline creation as an explicit proposal until the target-PR adapter boundary is
  independently approved; readiness itself remains strictly non-mutating.
- 2026-08-23: Recovered the prior Issue #61 implementation from its preserved sibling branch after the
  continuation workspace failed, then tightened status ambiguity handling, Live sync/status gating,
  baseline origin validation, and dashboard readiness reporting.

## Open questions and assumptions
- GitHub Project capability can be represented by an optional adapter response; unavailable access is
  an explicit unknown/blocker for Live, not for Demo.
- Existing projects may have no report column until the lightweight schema migration runs.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests and typecheck passed
- [x] Production build passed
- [x] Handoff implementation documented and PR verified

## Validation results
- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 99 tests after merging current
  `origin/main` priority changes.
- The focused readiness tests cover missing checkout, valid Git root, no execution of detected
  validation, default workflow selection, baseline proposal, and safe redaction. GitHub status
  mapping is exposed through the adapter capability method and retains the existing mocked adapter
  coverage. Additional safeguards reject ambiguous task status options and gate Live sync/status
  mutations on a fresh readiness assessment.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed after installing dependencies.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- `npm install` was required because dependencies were not present; npm reported existing audit
  vulnerabilities and Node 23 engine warnings. No dependency files were changed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — compilation and TypeScript passed,
  static generation passed; Next emitted the existing non-fatal NFT tracing warning for dynamic
  filesystem access in the workspace/orchestrator route.

## Handoff status
The implementation is on the dedicated feature branch with PR #69 open for human review:
https://github.com/maxlee98/project-agent-control-plane/pull/69. The branch was verified fresh against
`main` (`ahead=4`, `behind=0`) before the PR update. No automatic merge was performed. The existing NFT
tracing warning remains a human-review warning.