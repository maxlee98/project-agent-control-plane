# API contract

The control-plane API accepts JSON only for request bodies and returns safe, machine-readable errors.
Rejected request bodies are not logged or echoed.

## Error shape

Every failure uses:

```json
{
  "code": "TASK_NOT_FOUND",
  "message": "Task not found.",
  "details": { "field": "taskId" }
}
```

`details` is optional and contains only bounded field names, limits, or allowed values. Adapter errors,
credentials, request bodies, and provider responses are never returned directly.

Common codes include `INVALID_JSON`, `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`,
`VALIDATION_ERROR`, `INVALID_ENUM`, `INVALID_IDENTIFIER`, `PROJECT_NOT_FOUND`, `TASK_NOT_FOUND`,
`RUN_NOT_FOUND`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`,
`REMOTE_MUTATION_FAILED`, and `GITHUB_SYNC_FAILED`.

## Request limits

- JSON body: 64 KiB.
- Task title: 200 characters.
- Task description/comment: 12,000 characters.
- Project description: 4,000 characters.
- Repository name: 200 characters in `owner/repository` format.
- Labels: 20 items, 50 characters each.
- Idempotency key: 128 characters using letters, numbers, `.`, `_`, `:`, or `-`.

## Idempotency

`Idempotency-Key` is required for project registration/sync, task creation, run start, continue, retry,
task comments, and task status changes. The key is scoped to the operation and request fingerprint in the
local SQLite database.
Replaying the same key and payload returns the original response. Reusing a key for another operation or
payload returns `409` with `IDEMPOTENCY_CONFLICT`; an unfinished prior operation returns
`IDEMPOTENCY_IN_PROGRESS`. Use a new key only after checking whether the earlier remote side effect
completed.

Validation and resource existence checks happen before a key is claimed or any local/remote mutation is
attempted. `GET /api/runs/:runId` returns `404 RUN_NOT_FOUND` for unknown runs.

## Client recovery

For `400`, correct the indicated field or content type. For `404`, refresh the dashboard and verify the
resource. For `409 IDEMPOTENCY_IN_PROGRESS`, wait and poll instead of retrying the remote operation. For
`502` or polling failures, keep the workspace, check connectivity, and retry using the same key only
after confirming the previous operation did not complete; otherwise generate a new key.