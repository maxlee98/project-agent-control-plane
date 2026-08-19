# Repository Terminal Reliability

This repository has a terminal hard stop. These rules are mandatory.

## Absolute prohibitions

Agents MUST NOT send `cat >`, `cat >>`, `tee` multiline input, heredocs, `bash -c`, `sh -c`,
`zsh -c`, shell interactive flags, `eval`, nested shells, Python stdin/REPL/`-c`, Node inline
evaluation, unclosed quotes, command substitutions, or long inline command chains.

All multiline or quoted logic MUST be created with the editor/patch operation as an inspectable
`.py`, `.sh`, `.mjs`, or `.js` file, read back, and executed separately through:

```text
npm run safe:run -- --timeout-ms 120000 -- <direct-command> <args>
```

The runner uses `shell: false`, ignores child stdin, rejects unsafe command shapes, caps output,
and terminates timed-out process groups.

## Continuation prompt recovery

`quote>`, `dquote>`, `heredoc>`, bare `>`, Python `>>>`, and Python `...` mean incomplete input.

1. Cancel immediately with `Ctrl-C` or cancel the terminal invocation.
2. Never guess a closing quote, delimiter, or more source code.
3. Classify the operation as unknown.
4. Inspect the target, Git state, remote state, and relevant processes separately.
5. Resume only from the last verified checkpoint using a patch-created script and safe-runner.
