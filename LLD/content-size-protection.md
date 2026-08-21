# LLD: Protect Agent Requests from Oversized Content Filters

## Status

- **Status:** Complete; PR #38 open for human review
- **Owner:** Project Agent Control Plane
- **Date:** 2026-08-22
- **Related task or issue:** GitHub Issue #37 — prevent OpenRouter 403 failures caused by content-filter requests exceeding the provider's maximum input size.

## Problem and observed evidence

Live Cline runs can submit a request that is rejected before model execution with:

```text
403 Request blocked by content filter: Request content exceeds maximum size for content filtering
```

The current live path assembles `WORKFLOW.md`, task description, current summary, and the Cline
session's persisted history. `ClineCore` also provides built-in tools whose outputs can make later
turns substantially larger than the initial prompt. The provider response does not expose a usable
maximum in the observed error, so relying only on the model context window is unsafe.

## Goals

1. Create a reusable `content-size-protection` skill that agents can discover globally and in a
   fresh repository checkout.
2. Require a preflight size budget before a model request or continuation is sent.
3. Prefer selective context, summaries, targeted excerpts, and bounded tool output over full dumps.
4. Provide a deterministic recovery path for the OpenRouter 403 size-filter response.
5. Keep size telemetry useful without logging prompts, credentials, or sensitive file contents.

## Non-goals

- Do not silently truncate the user's task, acceptance criteria, or security constraints.
- Do not claim that a character estimate is an exact tokenizer or provider limit.
- Do not change ClineCore internals, provider APIs, the database schema, or run orchestration in this
  documentation/skill task.
- Do not retry an unchanged oversized request or route it to another provider without authorization.
- Do not read, persist, or print `.env` files, credentials, full prompts, or raw sensitive tool output.

## Requirements and acceptance criteria

- A global file exists at `~/.agents/skills/content-size-protection/SKILL.md` with valid skill metadata.
- A repository-local copy exists at `.agents/skills/content-size-protection/SKILL.md` so a fresh clone
  has the contract before global installation.
- The skill defines a conservative, configurable budget and explains that the total includes system
  instructions, task context, conversation history, tool definitions, and tool output.
- The skill requires character/byte measurement and approximate token estimation before submission.
- The skill bans full repository dumps, duplicate history, raw logs, generated artifacts, and secrets
  from model context unless a narrowly scoped excerpt is essential.
- The skill prescribes compaction before resume and chunked follow-up work when the complete task does
  not fit in one request.
- The skill identifies the observed OpenRouter 403 response and requires reduction before any retry.
- Contract tests verify stable metadata and the essential protections without network access.
- The installer is idempotent, uses an atomic write, and never prints skill contents or secrets.
- Changed files pass `git diff --check`, tests, typecheck, and build.

## Existing architecture and affected boundaries

- `src/lib/server/orchestrator.ts` assembles the initial live-run prompt.
- `src/lib/server/cline.ts` starts `ClineCore`, enables built-in tools, and owns the persisted session
  lifecycle.
- `.agents/skills/` contains repository-local skill overlays discovered by ClineCore.
- `~/.agents/skills/` contains the operator's global skills.
- `README.md` documents the safe installation command for the global skill.
- `scripts/install-terminal-hardening.mjs` establishes the repository convention for safe, idempotent
  global skill installation.

This task intentionally adds an operational skill rather than changing the runtime prompt builder.
The skill is the portable policy layer; runtime enforcement can be added later if observed metrics
show that instructions alone are insufficient.

## Proposed design

### Skill contract

The skill uses the following flow:

```text
collect context -> measure components -> compare with budget
  -> fit: submit concise request
  -> over budget: select/summarize/compact/chunk -> measure again -> submit
  -> 403 size-filter rejection: preserve state -> reduce further -> retry once
```

The default guidance uses a conservative target of 48,000 characters for the assembled request
context, with a 12,000-character per-excerpt target and a 16,000-character per-tool-result target.
These are safety defaults, not OpenRouter guarantees. Agents must lower them when provider metadata,
model limits, gateway policy, or repeated failures indicate a smaller effective limit. A request
budget is the sum of system instructions, workflow text, task/context text, history, tool schemas,
and tool results; measuring only the newest prompt is insufficient.

The skill requires recording only non-sensitive size metadata: component names, character/byte counts,
whether content was summarized, and the resulting status. It must not record the content used to make
those measurements.

### Context reduction order

Agents should reduce in this order:

1. Remove duplicate instructions, repeated tool output, stale progress events, and raw logs.
2. Replace completed history with a compact checkpoint containing decisions, changed paths, checks,
   and unresolved questions.
3. Replace broad file/repository dumps with targeted search results and bounded excerpts.
4. Exclude generated files, dependency lockfiles, binaries, minified assets, and unrelated modules.
5. Split the work into one objective per request and carry forward only the checkpoint needed for the
   next objective.

Task requirements, user decisions, security constraints, and exact failure evidence must remain
available. If those items alone exceed the budget, ask for a narrower scope or use a deliberate
multi-request workflow instead of silently deleting them.

### ClineCore/OpenRouter recovery

For the observed 403 response, the agent must classify it as an oversized content-filter request,
not as a successful model response and not as a reason to repeat the same request. It should:

1. Stop further automatic retries and preserve the local workspace/checkpoint.
2. Inspect request component sizes without logging the request body.
3. Compact persisted session history or start a fresh session with a minimal checkpoint when history
   cannot be reduced before the next provider call.
4. Remove duplicate/raw context and retry once with a newly measured request below the lower target.
5. If the reduced request is rejected again, stop and report the bounded measurements, omitted
   categories, and required human decision; do not loop or switch providers silently.

Where the SDK exposes compaction controls, configure/use them for long sessions, but still perform
host-side budgeting because compaction and provider content-filter limits are separate boundaries.

## Data and state transitions

No database state transition is introduced. The skill's operational state is:

```text
unmeasured context -> measured within budget -> submitted
                  \-> over budget -> reduced/compacted/chunked -> remeasured
                  \-> rejected 403 -> preserved checkpoint -> reduced retry once or blocked
```

## Risks, edge cases, and rollback

| Risk or edge case | Mitigation |
| --- | --- |
| Character counts differ from provider tokens | Treat tokens as approximate; use conservative byte/character budgets and provider metadata when available. |
| A compacted summary drops a required constraint | Preserve task requirements, user decisions, security rules, and failure evidence as non-droppable content. |
| A large single file is essential | Read/search targeted ranges or process it in explicit chunks; never embed the full file by default. |
| A provider rejects a request below the local target | Lower the effective target, record the result without payload content, and stop after the bounded retry. |
| A continuation session retains oversized history | Compact before `send`; create a fresh session with a verified checkpoint if compaction is unavailable. |
| Size telemetry leaks sensitive content | Record component labels and counts only; never log prompt text, environment files, tokens, or raw tool output. |
| Global and local skill copies drift | Install the global copy from the repository-local source and verify its marker/metadata after installation. |

Rollback removes the new skill, installer, tests, and LLD. No application data or remote state is
changed.

## Validation plan

1. Read back the local skill, installer, and LLD.
2. Install the global skill through the repository safe runner and read it back independently.
3. Run the content-size contract test without network access.
4. Run `git diff --check`, `npm test`, `npm run typecheck`, and `npm run build` as separate bounded
   commands.
5. Verify the installer is idempotent and no temporary process or secret output was produced.
6. Record exact validation outcomes and remaining warnings here.

## Decision log

- 2026-08-22: Chose a file-based skill because ClineCore discovers skills from `.agents/`/global
  skill locations and the requested fix should be portable across providers and repositories.
- 2026-08-22: Chose conservative measured budgets plus reduction/chunking instead of silent string
  truncation, because the provider's content-filter maximum is not exposed and truncation can remove
  requirements or security constraints.
- 2026-08-22: Treat the observed 403 as a bounded, non-idempotent request failure. An unchanged retry
  is explicitly prohibited.

## Validation results

- Global skill readback: verified `~/.agents/skills/content-size-protection/SKILL.md` contains the
  same metadata, budget, compaction, OpenRouter recovery, and secret-safety contract as the local
  overlay.
- Installer: first run installed the skill; second run reported `content-size-protection: already
  installed`, confirming idempotency. The installer validates source markers, writes through a
  process-specific temporary file, atomically renames it, and verifies the target content.
- Focused contract test: passed, 5 tests; it verifies skill metadata, complete-request measurement,
  selective context, compaction/chunking, bounded OpenRouter recovery, secret-safe installation, and
  workflow wiring.
- `npm run safe:run -- --timeout-ms 120000 -- npm test` — passed, 42 tests, 0 failures.
- `npm run safe:run -- --timeout-ms 120000 -- npm run typecheck` — passed; `tsc --noEmit` completed
  without diagnostics.
- `npm run safe:run -- --timeout-ms 120000 -- npm run build` — passed; Next.js compiled, typechecked,
  generated 5 static pages, and finalized route optimization. The existing non-fatal Turbopack NFT
  tracing warning through `next.config.mjs` and `src/lib/server/db.ts` remains unrelated.
- `npm run safe:run -- --timeout-ms 120000 -- git diff --check` — passed.
- Final pre-handoff inspection: only the intended skill, LLD, installer, test, README, workflow, and
  terminal-guidance files are changed/untracked on `fix/36-live-agent-run-reliability`; `.env.local`
  was not read or modified. GitHub Issue #37 was created and verified OPEN. PR #38 was created and
  verified OPEN against `main` with the expected feature head and `Fixes #37` linkage; the final LLD
  handoff commit is being published separately.

## Completion checklist

- [x] Design reviewed
- [x] Repository-local skill created
- [x] Global skill installed and read back
- [x] Installer and contract tests added
- [x] Documentation cross-references added
- [x] Diff, tests, typecheck, and build completed
- [x] Handoff verified