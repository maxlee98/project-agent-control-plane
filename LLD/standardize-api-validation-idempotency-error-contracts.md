# LLD: Standardize API Validation, Idempotency, and Error Contracts

## Status
- Status: Complete (PR creation blocked: canonical GitHub issue identity not supplied)
- Owner: Project Agent
- Date: 2026-08-22
- Related task or issue: Project Agent task “Standardize API validation, idempotency, and error contracts”; canonical GitHub issue identity not supplied

## Problem
The Next.js API routes currently parse arbitrary JSON and perform local or GitHub side effects without
a shared request contract. Invalid identifiers, oversized fields, malformed JSON, and unsupported enum
values can reach adapters or persistence. Several mutation requests are retry-prone, and the UI does not
consistently surface failed responses. Unknown run resources also need an explicit 404 contract.

## Goals
- Add dependency-free shared request parsing, content-type/body-size checks, field validation, and a
  stable `{ code, message, details? }` JSON error shape.
- Apply the shared boundary to every JSON API route before side effects and return 404 for unknown
  project/task/run resources.
- Add request-key deduplication for task creation and run-control mutations, with a stable conflict
  response for a reused key with a different operation.
- Make dashboard polling and mutation failures actionable in the control-room UI.
- Document the contract and cover malformed, oversized, invalid, replayed, unknown-resource, and safe
  serialization behavior with isolated tests.

## Non-goals
- No authentication or authorization redesign.
- No product UI redesign or GitHub status model changes.
- No automatic retries of non-idempotent remote operations without a request key.
- No logging of rejected request bodies, secrets, or raw adapter errors.

## Requirements and acceptance criteria
- All JSON routes enforce `Content-Type: application/json`, a bounded body, JSON object input,
  field types/ranges/lengths, and allowed enums before mutation.
- Errors serialize as a stable safe shape with machine-readable codes and redacted details.
- Unknown project/task/run identifiers are 404s and do not mutate state or call remote adapters.
- Replayed task creation and run-control operations are deduplicated or rejected with a stable conflict.
- Polling and mutation failures show actionable retry guidance.
- Tests demonstrate no remote side effect for rejected input and safe error serialization.

## Existing architecture
- `src/app/api/**/route.ts` contains the route handlers.
- `src/lib/server/repository.ts` owns SQLite persistence and domain mapping.
- `src/lib/server/db.ts` owns SQLite schema and migrations.
- `src/lib/server/github.ts` owns remote Issue/comment/status operations.
- `src/lib/server/orchestrator.ts` owns run lifecycle dispatch.
- `src/components/ControlPlane.tsx` polls the dashboard and sends mutations.
- The repository intentionally has no schema dependency; validation will follow existing TypeScript
  conventions.

## Proposed design
Create `src/lib/server/api.ts` with:
1. Constants for request body and mutable-field limits.
2. `parseJsonBody` enforcing content type, `Content-Length`/streamed byte limits, JSON syntax, and a
   plain object root.
3. Small validators for strings, repository/node IDs, integers, enum values, arrays, and optional fields.
4. `apiError`/`apiResponse` helpers and safe error normalization that never returns raw adapter
   messages or request data.
5. `requireResource`-style route checks implemented at each route boundary.

Add a SQLite `request_deduplication` table keyed by operation and idempotency key. A repository helper
claims a key atomically and returns replay/conflict metadata. Routes require `Idempotency-Key` for
operations that can create or trigger remote side effects (task creation and run start/continue/retry),
while stop is naturally safe and remains replayable by run state. The key is claimed only after resource
and body validation and before invoking the orchestrator/GitHub adapter.

## Data and state transitions
```text
request -> content type/body parse -> schema validation -> resource lookup
         -> dedup claim -> local/remote side effect -> response
```
Rejected requests exit before dedup claims and before all side effects. A replay returns the original
operation result where it is persisted, or a stable `IDEMPOTENCY_CONFLICT` when the key is reused for a
different operation. In-process/local SQLite scope is explicit for this MVP.

## Affected files and boundaries
- `src/lib/server/api.ts`: shared request/error/validation helpers.
- `src/lib/server/db.ts`: additive deduplication schema.
- `src/lib/server/repository.ts`: dedup claim/result persistence and resource helpers.
- `src/app/api/**/*.ts`: consistent validation, resource checks, and error responses.
- `src/components/ControlPlane.tsx`: response handling and actionable error state.
- `docs/api-contract.md`: operator/developer contract.
- `tests/api-contract.test.ts`: isolated route/helper coverage.

## Risks, edge cases, and rollback
- Stricter validation may reject malformed existing clients; messages include the field/code needed to
  migrate callers.
- A process crash after claiming a key can leave an in-progress key. Store status and permit a bounded
  replay response rather than repeating an unknown remote side effect.
- Existing databases receive only additive schema changes. Removing route use of the helper is a
  reversible rollback; the table can remain unused.
- Streaming request bodies must be cancelled once the byte cap is exceeded and must not be logged.

## Validation plan
- Add unit/route tests with temporary SQLite state and mocked remote/orchestrator boundaries.
- Run the focused API contract tests, full test suite, `npm run typecheck`, `npm run build`, and
  `git diff --check` through the repository safe runner.
- Confirm rejected requests do not invoke remote adapters and error details do not echo secrets/body.

## Decision log
- 2026-08-22: Keep validation dependency-free to match the repository's current conventions and avoid
  introducing a schema runtime for a small, explicit API surface.
- 2026-08-22: Use an explicit `Idempotency-Key` header for non-idempotent mutations; do not infer keys
  from request bodies or silently retry remote operations.

## Open questions and assumptions
- The task context does not include a canonical GitHub issue number; PR creation must wait for that
  identity under repository policy.
- This local SQLite implementation is not a distributed idempotency store; hosted deployments need a
  durable shared store in the migration path.
- Existing browser clients should be updated to send keys for start/continue/retry/task creation.

## Completion checklist
- [x] Design reviewed
- [x] Implementation complete
- [x] Implementation self-review completed
- [x] Tests and typecheck passed; production build passed with `NODE_ENV=production`
- [x] Documentation updated
- [ ] Handoff verified — blocked before PR by missing canonical Issue identity

## Validation results
- `npm test` — passed, 76 tests.
- Focused API/idempotency test selection — passed.
- `npm run typecheck` — passed.
- `env NODE_ENV=production npm run build` — passed; one existing Turbopack NFT tracing warning remains.
- `npm run build` without the explicit production environment — failed in the existing Next prerender
  path for `/_global-error` with React `useContext` null because the ambient `NODE_ENV` was non-standard;
  the production-mode build passes.
- `git diff --check` — passed.
- `npm install` — completed; npm reported existing dependency audit and Node-engine warnings.
- No remote PR was created because the task context does not provide a verified canonical GitHub Issue
  identity required by repository policy.