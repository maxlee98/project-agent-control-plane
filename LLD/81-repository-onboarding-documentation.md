# LLD: Repository Onboarding Documentation and README Reference Index

## Status

- **Status:** Implemented; pending review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-23
- **Related issue:** [#81](https://github.com/maxlee98/project-agent-control-plane/issues/81)

## Problem

The control plane's root README explains how to start the application and enable Live mode, but it
does not provide a single checklist for adding and validating a managed repository. The Add repository
flow currently stores a GitHub `owner/repository`, local checkout path, optional Projects V2 node ID,
and description; it does not yet run the repository-readiness feature described in the separate
readiness product issue.

Important guidance is distributed across the README, environment example, workflow contract, and
architecture, security, API, local SQLite, and terminal-reliability documents. Operators can therefore
miss requirements for Git identity, isolated worktrees, effective workflow policy, validation checks,
Projects V2 status and priority fields, host-side credentials, or human-reviewed pull-request handoff.

## Goals

1. Add a canonical `docs/repository-onboarding.md` checklist for registering a new managed repository.
2. Distinguish registration, Demo-mode, and Live-mode requirements.
3. Document safe stop conditions, baseline-file handling, secrets boundaries, and human handoff.
4. Add a discoverable README documentation index linking to important operational and policy documents.
5. Keep current manual behavior separate from future repository-readiness automation.

## Non-goals

- Do not implement readiness APIs, dashboard checks, Live preflight enforcement, or baseline PR
  automation.
- Do not modify a managed target repository or GitHub Projects configuration as part of onboarding
  documentation.
- Do not change runtime, database, security, workflow, or pull-request enforcement behavior.

## Existing architecture and documentation boundaries

- `README.md` is the contributor and operator entry point.
- `docs/repository-onboarding.md` will be the detailed managed-repository checklist.
- `workflows/default/WORKFLOW.md` is the default agent behavior contract; a target repository's
  `WORKFLOW.md` takes precedence when present.
- `docs/architecture.md` describes runtime ownership, source-of-truth rules, integration seams, and
  Live-run verification.
- `docs/security-model.md` describes host-side secrets, worktree, autonomy, and local-data guardrails.
- `docs/local-operations.md` describes SQLite backup, restore, and retention procedures.
- `docs/api-contract.md` describes request limits, errors, idempotency, and client recovery.
- `docs/terminal-reliability.md` describes the safe-runner and interruption recovery contract.
- `.github/pull_request_template.md` defines the required review handoff.

## Proposed design

### Root README changes

Add an onboarding section near the existing Repository setup section that:

- links to the detailed checklist;
- summarizes the three onboarding levels;
- states that registration currently records metadata only and does not silently alter the checkout;
- explains that Demo mode does not require Live credentials or a GitHub Project;
- links to the environment example and the Live-mode prerequisites; and
- points operators to the documentation index for deeper contracts.

Add a documentation index containing links to the onboarding, architecture, API, security, local
operations, terminal-reliability, workflow, PR template, and environment-reference documents.

### Detailed onboarding checklist

The new checklist will be organized into:

1. Scope and mode selection.
2. Registration inputs.
3. Local checkout and Git verification.
4. Policy, skills, templates, and validation discovery.
5. GitHub Projects V2 configuration.
6. Runtime and secret configuration.
7. Demo verification.
8. Live preflight and human-review handoff.
9. Troubleshooting and safe stop conditions.

Each item will identify whether it is required for registration, Demo operation, or Live operation.
The checklist will use relative links to existing repository documents and will avoid suggesting that
the future readiness implementation is already available.

### Baseline and safety policy

The documentation will state that a missing target `WORKFLOW.md`, `AGENTS.md`, local skill, or pull
request template is a finding to review, not permission for silent copying. If a baseline is desired,
it must be proposed on a dedicated target-repository branch and delivered through a pull request with
human review. Secrets remain host-side and are never placed in target-repository files, task comments,
run events, or PR descriptions.

## Acceptance criteria

- `docs/repository-onboarding.md` provides a copyable checklist covering identity, checkout/Git,
  worktrees, effective policy, skills/templates, validation, Projects V2, runtime, Demo, Live, and
  human handoff.
- The checklist distinguishes registration, Demo, and Live requirements and includes remediation and
  stop conditions.
- `README.md` links to the checklist and important architecture, API, local-operations, security,
  terminal-reliability, workflow, environment, and PR-template references.
- Current/manual behavior and future/planned readiness automation are explicitly separated.
- Documentation does not expose secrets or imply that baseline files are silently installed.
- Documentation-only changes pass whitespace validation, tests, typecheck, and build.
- The PR explicitly closes Issue #81 and uses the repository PR template.

## Risks and rollback

| Risk | Mitigation |
| --- | --- |
| Checklist drifts from runtime behavior | Derive requirements from current API, workspace, GitHub, workflow, security, and README contracts; read back all links. |
| Operators mistake planned readiness for an available feature | Label readiness automation as planned and describe the current manual flow. |
| Documentation encourages unsafe target-repository changes | Require explicit target-repository branch/PR handling and host-side secrets. |
| Long checklist becomes difficult to use | Use short checkboxes grouped by onboarding stage and link to deeper documents rather than duplicating them. |

Rollback is reverting the documentation-only commit. There is no runtime, database, or target-repository
impact.

## Validation plan

1. Read back the LLD, onboarding checklist, and README for consistency.
2. Verify every relative documentation link points to an existing repository file.
3. Run `npm run safe:run -- --timeout-ms 120000 -- git diff --check`.
4. Run `npm run safe:run -- --timeout-ms 120000 -- npm test`.
5. Run `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck`.
6. Run `npm run safe:run -- --timeout-ms 120000 -- npm run build`.
7. Verify branch freshness, validate the completed PR body with `scripts/verify-pr-template.mjs`, and
   create/update the PR only through `scripts/create-pr.mjs`.

## Validation results

- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed; 112 tests passed, 0 failed.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed with no TypeScript diagnostics.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed; Next.js compiled and finalized
  route optimization. The existing non-fatal Turbopack NFT tracing warning remains outside this
  documentation-only scope.
- `npm run safe:run -- --timeout-ms 30000 -- git diff --check` — passed before staging.

## Decision log

- 2026-08-23: Use one detailed `docs/repository-onboarding.md` document rather than a second root
  README, and expose it through a README reference index.
- 2026-08-23: Keep this task documentation-only; repository-readiness automation remains a separate
  implementation concern.
- 2026-08-23: Issue #81 is the canonical task identity and will be linked with `Fixes #81` in the PR.

## Completion checklist

- [x] LLD created and reviewed
- [x] Repository onboarding checklist added
- [x] README onboarding guidance and documentation index added
- [x] Links and wording reviewed against current implementation
- [x] Diff check, tests, typecheck, and build passed
- [ ] Branch freshness verified
- [ ] Template-compliant PR opened and verified
- [ ] Human merge approval remains pending