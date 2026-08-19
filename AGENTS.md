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

## LLD and handoff

Before changing code, read or create `LLD/<task-slug>.md`. On every context resumption, reread the
LLD before making another design or code decision. Every change is branch-and-PR first; never push
directly to `main`, and never merge automatically.
