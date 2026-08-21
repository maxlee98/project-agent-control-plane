# Agent operating contract

This repository has a **terminal hard stop**. These rules are mandatory, not suggestions.

## Absolute command prohibitions

For agent-authored work, **MUST NOT** send any of the following to a terminal:

- shell-fed file authoring: `cat >`, `cat >>`, `tee` for multiline content, or any `<<` heredoc;
- Python stdin or REPL forms: `python`, `python3`, `python -`, `python3 -`, `python -c`, or
  `python3 -c` for authored logic;
- shell inline-evaluation forms: `bash -c`, `sh -c`, `zsh -c`, shell `-i`, `eval`, or nested shells;
- Node/Python inline evaluation for authored logic: `node -e`, `node --eval`, or long quoted `-c`;
- unclosed quotes, backslash continuations, command substitutions, or guessed closing delimiters;
- long inline command chains using `&&`, `||`, `;`, or multiple unrelated side effects;
- any command that can consume terminal stdin without an explicit, reviewed reason.

Do not create an exception by using a complete heredoc. For multiline or quoted logic, use the
patch/editor operation to create a real, inspectable `.py`, `.sh`, `.mjs`, or `.js` script. Read the
script back, then run it as a separate direct invocation through the safe runner.

## Mandatory execution protocol

Use the repository runner for every agent-authored development command:

```text
npm run safe:run -- --timeout-ms 120000 -- <direct-command> <args>
```

The runner uses `shell: false`, ignores child stdin, rejects unsafe command shapes, caps output,
and terminates timed-out process groups. Use one logical operation per invocation. Inspect first,
mutate once, and verify separately.

Examples:

```text
npm run safe:run -- --timeout-ms 120000 -- npm test
npm run safe:run -- --timeout-ms 120000 -- npm run typecheck
npm run safe:run -- --timeout-ms 120000 -- bash /tmp/checked-task-script.sh
```

The examples intentionally contain no shell quoting or shell composition. Do not wrap them in
`bash -c`, `zsh -c`, `sh -c`, command substitution, or a heredoc.

## Continuation-prompt emergency stop

The prompts `quote>`, `dquote>`, `heredoc>`, bare `>`, Python `>>>`, and Python `...` mean input is
incomplete. They never mean success.

1. Press `Ctrl-C` or cancel the terminal invocation immediately.
2. Do **not** type a guessed quote, delimiter, or more source code.
3. Classify the operation as `unknown — command/tool interrupted`.
4. In separate bounded commands, inspect the target file, `git status`/`git diff --check`, and any
   relevant process or remote state.
5. Resume only from the last verified checkpoint using a patch-created script and the safe runner.

If a command was already submitted directly to an external shell, this repository cannot intercept
the shell parser. Prevention therefore depends on obeying the absolute prohibitions above.

## Compulsory pull-request template

Every pull request MUST use `.github/pull_request_template.md` as its single source of truth.
Agents MUST NOT create an abbreviated ad-hoc PR body through REST, curl, or a custom script.

1. Create the body in a patch-created file.
2. Run `npm run safe:run -- --timeout-ms 120000 -- node scripts/verify-pr-template.mjs --body-file <path>`.
3. Create or update the PR only through `scripts/create-pr.mjs` with the validated body file.
4. Query the PR afterward and verify its number, URL, state, base, head, and template headings.

The CI workflow `validate-pr-template.yml` is the server-side gate. A PR with missing headings,
unresolved template comments, incomplete validation results, or incomplete security checks must fail
the gate and must not be considered ready for human review.

## Feature-branch freshness

Before creating or updating any PR, the feature head MUST contain the current `main` history:

1. Run `npm run safe:run -- --timeout-ms 30000 -- node scripts/verify-branch-freshness.mjs --base main --head <feature-branch>`.
2. If it is behind or diverged, run `scripts/update-branch-from-main.mjs --strategy update` or
   `--strategy rebase` from a clean feature worktree.
3. Re-run the freshness verifier; only then validate the PR body and call `scripts/create-pr.mjs`.

`scripts/create-pr.mjs` repeats this check before every remote PR write and refuses stale heads.
The update strategy merges `origin/main`; the rebase strategy rewrites local history. Neither
strategy force-pushes. A rebased published branch requires an explicit, separately reviewed
`--force-with-lease` push on the feature branch.

## LLD and handoff

Before changing code, read or create `LLD/<task-slug>.md`. On every context resumption, reread the
LLD before making another design or code decision. Every change is branch-and-PR first; never push
directly to `main`, and never merge automatically.
Every PR must explicitly link one canonical GitHub Issue with `Fixes #<number>` or `Closes #<number>`.
The closing keyword creates the GitHub Development relationship and closes the Issue when the PR
merges. The Issue is the sole task item on the Issue-only GitHub Project board; the PR is a linked
implementation artifact and must not be added as a second board item. If no Issue identity is
available, stop before PR creation rather than substituting a local task ID or inventing an Issue number.
