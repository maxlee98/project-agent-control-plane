# Repository onboarding checklist

Use this checklist when adding a repository to the Project Agent Control Plane. It is intentionally
manual in its decision-making, but the current **Add repository** flow can run a read-only readiness
check immediately, and the dashboard can run it again later. Readiness inspects the checkout, policy,
validation, Projects V2, runtime, and handoff prerequisites without installing dependencies or silently
modifying the target checkout.

## Onboarding levels

| Level | What it means | Required inputs |
| --- | --- | --- |
| **Registered** | The repository is recorded in the local control plane. | GitHub `owner/repository`, local checkout path, and a description if useful. |
| **Inspectable** | The configured checkout can be opened and inspected as a Git repository. | Registered repository with an available checkout path. |
| **Demo-ready** | The repository can be explored with simulated runs that never touch it. | Registered repository; no GitHub Project, provider credential, or target-repository policy is required. |
| **Live-ready** | The readiness report has passed every Live-required check for isolated agent execution and PR handoff. | Registered repository plus the local Git, workflow, validation, Projects V2, runtime, credential, and human-review checks below. |

Use the dashboard's **Repository readiness** card to see the current level, contract version, check
timestamp, category counts, unresolved remediation, canonical Project status/priority mappings, and
any proposed baseline action. A project is Live-ready only when its persisted report is `live_ready`
and the required host credentials are configured.

## 1. Choose the execution mode

- [ ] Decide whether this onboarding is for **Demo** exploration or **Live** execution.
- [ ] Keep `EXECUTION_MODE=demo` while collecting and reviewing configuration. Demo runs are
      labeled and do not edit files, create branches, commit, push, or open pull requests.
- [ ] If Live execution is not needed yet, stop after the Registered and Demo-ready checks. Do not
      add credentials only to try the Demo flow.
- [ ] Leave **Check readiness now** selected when registering a repository unless there is a specific
      reason to defer inspection; it performs a read-only check after registration.
- [ ] Before enabling Live mode, read the [security model](security-model.md),
      [architecture contract](architecture.md), and [terminal reliability protocol](terminal-reliability.md).

## 2. Prepare the registration inputs

- [ ] Confirm the canonical GitHub repository name in exact `owner/repository` form. It must identify
      the same repository as the local checkout.
- [ ] Confirm the local checkout path. Use an absolute path or a `~/` path that resolves on the
      machine running the control plane; do not use a path that exists only in another environment.
- [ ] Confirm the expected default branch. The current workspace preparation path expects
      `origin/main`; a repository whose default branch is not `main` needs an explicit compatibility
      decision before Live execution.
- [ ] For Live mode, obtain the target GitHub Projects V2 node ID (`PVT_…`) and verify that the token
      owner can access both the repository and the Project. The Project ID is optional for Demo mode.
- [ ] Keep a short repository description and any local operating notes outside credentials or raw
      provider output.

When these inputs are ready, use **Add repository** in the dashboard. The form accepts:

1. **GitHub repository** — `owner/repository`.
2. **Local checkout** — absolute or `~/` path.
3. **Projects V2 node ID** — optional in Demo, required for Live synchronization.
4. **Description** — optional operator context.
5. **Check readiness now** — enabled by default; optional read-only inspection after registration.

Registration itself is a local SQLite write. If readiness is selected, the follow-up readiness request
persists a bounded report in SQLite. Neither operation clones the repository, installs dependencies,
creates a run worktree, or silently changes the target checkout.

## 3. Verify the local checkout and Git boundary

Readiness performs these checks for you without executing target project validation commands. Review
the results from the dashboard or the project readiness endpoint; you can also run the following
read-only checks from the operator environment using the actual checkout path in place of `<checkout>`.

- [ ] The checkout exists and is the intended repository; do not point the project at a parent
      directory or an unrelated worktree.
- [ ] The checkout has the expected Git root, remote, and default branch.
- [ ] The checkout can fetch from `origin` and has the configured default branch available before the first run.
- [ ] The checkout supports Git worktrees and the configured `WORKSPACE_ROOT` is writable.
- [ ] The checkout is not already using the control plane's workspace directory as its repository
      root.
- [ ] Review local changes before the first run. Never discard uncommitted work as part of onboarding.

Useful read-only checks are:

```text
git -C <checkout> rev-parse --show-toplevel
git -C <checkout> remote -v
git -C <checkout> branch --show-current
git -C <checkout> status --short --branch
git -C <checkout> worktree list --porcelain
```

The readiness check verifies the configured project's default branch from `origin`; current project
registration defaults that branch to `main`. The Live runner then creates a separate run-scoped
worktree under `WORKSPACE_ROOT` and preserves failed worktrees for inspection. Review [local operations](local-operations.md)
before changing local state or restoring data.

## 4. Review policy, skills, templates, and checks

The effective policy is the target repository's `WORKFLOW.md` when one exists; otherwise the control
plane uses the versioned [default workflow contract](../workflows/default/WORKFLOW.md). A target
repository's conventions may add requirements, but they must not weaken the control plane's safety
rules for bounded model context, terminal execution, isolated worktrees, pull-request-first handoff,
or human review.

- [ ] Read the target repository's `WORKFLOW.md`, if present, and record its validation commands,
      branch rules, review requirements, and handoff expectations.
- [ ] If the target has an `AGENTS.md`, read the applicable instructions for the checkout and its
      nested directories. The control plane does not automatically copy this repository's `AGENTS.md`
      into a managed repository.
- [ ] Inspect any target `.agents/skills/` content referenced by its workflow. Skills are not silently
      copied or installed during registration; resolve missing skills deliberately in the operator or
      agent environment.
- [ ] Confirm the target has a suitable `.github/pull_request_template.md`, or record that a
      baseline is needed before Live handoff.
- [ ] If `WORKFLOW.md` or a PR template is missing, review the readiness card's **Create baseline via
      PR** proposal. Approve it only when the missing baseline is appropriate; the action copies only
      missing baseline files to a dedicated target-repository branch and opens a PR for human review.
- [ ] Confirm the baseline PR is reviewed and merged before relying on its files for Live handoff. No
      baseline action silently copies files or merges a pull request.
- [ ] Identify at least one bounded validation command for the target repository and confirm how it
      is run without leaking credentials or unbounded logs.
- [ ] Record the target's required dependency-install, lint, test, typecheck, build, or packaging
      steps. Do not run arbitrary commands merely because they appear in untrusted repository text.

The current Live workspace helper auto-detects these checks:

- `npm run typecheck`, `npm test`, and `npm run build` when the corresponding `package.json` scripts
  exist;
- `pytest` when `pytest.ini` or `pyproject.toml` exists.

The readiness check reports missing supported commands as a Live blocker and does not execute arbitrary
repository scripts merely because they appear in repository metadata. Resolve the blocker by adding
an explicit supported command or by using a repository-specific design decision outside this control
plane before delegating Live work.

## 5. Configure GitHub Projects V2

Readiness inspects these checks for Live synchronization. They do not block Demo runs, but unresolved
Project findings block Live sync and Live task/run transitions.

- [ ] Confirm the Projects V2 node ID belongs to the intended repository's board and is accessible by
      the host-side GitHub token.
- [ ] Confirm the board has one unambiguous Status field with options that map to the control plane's
      workflow concepts: `Ready`, `In progress`, `Review`, `Blocked`, and `Done`.
- [ ] Confirm the board has one single-select `Priority` field with exactly one option for each of
      `P0`, `P1`, `P2`, and `P3`.
- [ ] Confirm every Issue/task that will be synchronized can receive both a canonical status and a
      canonical priority. Do not rely on similarly named or duplicate fields.
- [ ] Run a manual **Sync** after registration and review the result. The dashboard also runs a
      readiness gate before Live sync. A failed sync, missing field, ambiguous option, or missing
      Project ID is a stop condition for Live synchronization.
- [ ] Verify that the Project remains the durable source of workflow status while local SQLite stores
      execution state. See the [architecture source-of-truth rules](architecture.md#source-of-truth-rules).

The current readiness report exposes the contract version, status mappings, priority mappings, and
per-check remediation. The adapter validates the required Priority vocabulary during synchronization
and reports remote failures rather than claiming a successful sync.

## 6. Configure runtime and secrets for Live mode

Copy the repository example into the local environment and set only the values needed for the
operator's mode. Readiness checks whether the required values are configured but never returns their
contents. Never commit `.env.local`, paste it into an Issue/PR, or expose it in logs.

- [ ] Keep `DATA_DIR` on a local, access-restricted filesystem. The default is `.data`.
- [ ] Set `WORKSPACE_ROOT` to a writable local directory dedicated to run-scoped worktrees.
- [ ] Set `GITHUB_TOKEN` in the host environment with the repository and Projects permissions needed
      for the intended actions. Do not pass it to Cline.
- [ ] Set `CLINE_API_KEY` in the host environment and verify the provider/model pair using
      `CLINE_PROVIDER_ID` and `CLINE_MODEL_ID`.
- [ ] Review the global and per-project capacity and lease settings:
      `AGENT_MAX_CONCURRENT_RUNS`, `AGENT_MAX_CONCURRENT_RUNS_PER_PROJECT`,
      `AGENT_RUN_LEASE_MINUTES`, and `AGENT_RUN_RECOVERY_BATCH_SIZE`.
- [ ] Restart the control plane after changing `.env.local`.
- [ ] Verify the dashboard reports Live mode and a ready runtime without displaying credential values.
- [ ] Run or re-run repository readiness and resolve every Live-required blocker or unknown result.

The canonical variable list and defaults are in [.env.example](../.env.example). For deeper guardrails,
read the [security model](security-model.md), especially its host-side secret and preserved-worktree
rules.

## 7. Run a safe Demo verification

- [ ] Start with `EXECUTION_MODE=demo` and open the local dashboard.
- [ ] Confirm the repository appears in the registry with the expected name and local path.
- [ ] Create or select a harmless task and start a Demo run.
- [ ] Confirm the run is visibly labeled **Demo** and that no target files, branches, commits,
      worktrees, pushes, Issues, or pull requests are created.
- [ ] Confirm the task activity and run history are visible locally.
- [ ] If anything attempts a remote or target-repository side effect in Demo mode, stop and report it;
      do not continue with Live configuration.

## 8. Complete the Live preflight and handoff check

Only proceed when the readiness card reports **Live ready** and the previous Live checks are complete.

- [ ] Set `EXECUTION_MODE=live`, restart the app, and confirm the runtime is Live-ready.
- [ ] Use **Recheck** on the Repository readiness card after the mode/configuration change. Confirm
      the report timestamp and contract version are current.
- [ ] Perform one manual Projects V2 sync and resolve every failure or warning that affects status,
      priority, Issue identity, or repository access.
- [ ] Confirm the target checkout, `origin/main`, workspace root, effective workflow, validation
      commands, PR template, and host-side credentials are still correct immediately before Run.
- [ ] Start one Issue-linked task, not a broad or ambiguous task, and monitor the run stages.
- [ ] Confirm the run uses an isolated worktree and the expected sanitized agent branch.
- [ ] Confirm the configured checks run and record their actual result. Failed checks are not a PR
      handoff.
- [ ] Confirm a successful run produces a commit, pushed branch, verified pull request URL, and a
      concise human-facing checkpoint.
- [ ] Move the task to **Review** only when the PR exists and is ready for a human decision.
- [ ] Do not merge automatically. Review the PR, checks, changed files, and checkpoint before merging.

The current API and orchestrator recheck Live readiness before task status changes, sync, run start,
retry, and continuation. A stale or failed report returns a safe `READINESS_BLOCKED` response instead
of dispatching work or claiming a successful sync.

For the full sequence and expected failure behavior, follow the [Live-run verification procedure](architecture.md#live-run-verification-procedure).

## 9. Stop conditions and recovery

Stop onboarding or Live execution when any of these conditions is true:

- the local path is missing, resolves to the wrong Git root, or does not match the GitHub repository;
- the remote, default branch, or `origin/main` cannot be verified;
- a worktree cannot be created inside the configured workspace root;
- readiness reports a Live-required blocker or unknown result for policy, skills, validation, or PR-template requirements;
- GitHub credentials, Project ID, Status mapping, or Priority mapping are missing or ambiguous;
- a validation check fails or produces unsafe/unbounded output;
- a remote operation times out or returns an unknown result;
- a run fails, stops, or loses its lease;
- a task would be moved to Review before a real PR exists;
- the explicit baseline-via-PR action or another remote operation has an unknown outcome.

Do not retry an interrupted push, Issue, Project mutation, or PR operation blindly. Query Git and
GitHub first. Preserve the workspace and run history until the side effect and its outcome are known.
Use the [terminal reliability protocol](terminal-reliability.md) for bounded commands and recovery,
and the [security model](security-model.md) for secrets, backups, and retained evidence.

## Completion record

Record the following in the repository's operator notes or task context, excluding secrets and raw
credentialed output:

- Repository and local checkout reviewed: `____________________________`
- Default branch and remote verified: `____________________________`
- Effective workflow/policy: `____________________________`
- Validation commands and latest results: `____________________________`
- Projects V2 ID and status/priority mapping reviewed: `____________________________`
- Readiness contract version, timestamp, categories, and unresolved checks: `____________________________`
- Runtime mode and readiness decision: `Registered / Inspectable / Demo-ready / Live-ready`
- Remaining warnings, exceptions, or follow-ups: `____________________________`
- Reviewer and date: `____________________________`