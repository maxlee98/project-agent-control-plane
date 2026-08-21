---
name: content-size-protection
description: Use when preparing or continuing Cline/LLM requests, especially through OpenRouter. Prevents content-filter size failures by measuring context, selecting relevant excerpts, compacting history, and chunking oversized work.
---

# Content-Size Protection

Use this skill before starting or continuing any model request when the prompt includes repository
context, tool output, persisted history, or large user-provided material.

## Core rule

```text
collect -> measure -> fit the budget -> submit once
                         \-> reduce/compact/chunk -> measure again -> submit
```

Never submit an unmeasured large request. Never retry an oversized request unchanged.

## Budget before the provider call

Count the complete request, not only the newest user message. Include system instructions,
`WORKFLOW.md`, task/context text, conversation history, tool definitions, and tool results. Measure
characters and UTF-8 bytes; estimate tokens as an approximation only (`characters / 4` is a rough
heuristic and varies by language, code, and serialization). Use model/provider metadata when
available, but do not assume the model context window is the content-filter limit.

Use these conservative starting targets unless a stricter provider limit is known:

- **48,000 characters** for the assembled request context;
- **12,000 characters** for one file or search excerpt;
- **16,000 characters** for one tool result;
- compact history before it approaches the assembled-request target.

These are safety targets, not provider guarantees. Lower them after a provider rejection or when a
gateway/model policy is smaller. Record only component labels and counts, never the measured content.

## Context selection

Keep the task title, acceptance criteria, user decisions, security constraints, exact failure
evidence, relevant workflow rules, and the smallest useful repository excerpts. Prefer targeted
searches and line ranges over full files or repository dumps.

Remove or summarize, in this order:

1. Duplicate instructions and repeated tool results.
2. Completed conversation turns, raw event streams, and verbose logs.
3. Broad file dumps and unrelated modules.
4. Generated files, dependency/vendor directories, lockfiles, binaries, minified assets, and caches.
5. Work that can be split into a separate objective with a short checkpoint.

Do not include `.env`, `.env.local`, credentials, tokens, authorization headers, or process
environments. Do not silently truncate task requirements or security constraints; preserve them or
ask for a narrower scope.

## Compaction and chunking

For long ClineCore sessions, compact persisted history before `send`/resume using the runtime's
available compaction mechanism. A useful checkpoint contains only decisions, changed paths,
validation results, blockers, and the next objective. If history cannot be compacted before the next
provider call, start a fresh session with that verified checkpoint rather than forwarding the full
history.

When the task does not fit, split it into one objective per request. Carry forward only the
checkpoint and targeted context required for that objective. Re-measure every chunk independently.

## OpenRouter 403 size-filter recovery

Treat this response as a request-size failure:

```text
403 Request blocked by content filter: Request content exceeds maximum size for content filtering
```

1. Stop automatic retries and preserve the workspace/checkpoint.
2. Inspect component sizes without printing or persisting the request body.
3. Remove duplicate history/raw output, compact or replace the session, and lower the target.
4. Construct and measure a new, smaller request; retry at most once.
5. If it fails again, stop and report counts, omitted categories, and the human decision needed.

Do not classify this as success, retry the identical payload, loop indefinitely, or silently switch
providers/models. A provider's missing metadata does not justify sending a larger request.

## Handoff and telemetry

Report non-sensitive size metadata only: approximate before/after character and byte counts,
component categories reduced, whether history was compacted, and whether work was chunked. Never
log full prompts, raw tool output, environment files, or secrets.

## Completion checklist

- [ ] Complete request components measured
- [ ] Provider/model limit checked where available
- [ ] Context reduced to relevant excerpts
- [ ] History compacted or work chunked
- [ ] New request remeasured before retry
- [ ] No secrets or raw oversized output logged
- [ ] Omitted context and remaining uncertainty recorded