# Tool Usage Notes

Tool signatures are automatically provided through function calling. This section
records general tool contracts and less obvious usage patterns.

## General Tool Contract

- Use the narrowest structured tool that directly matches the task.
- When state is uncertain, perform only enough read-only discovery to identify the cause, the smallest relevant change, and a verification step.
- Do not treat `exec` as a universal workaround for files, search, web, messages, or scheduling.
- If a tool fails, read the error, refresh the relevant state, and retry with a different method instead of repeating the same call.
- Treat safety and workspace-boundary errors as real limits, not obstacles to bypass.

{% include 'agent/verification-contract.md' %}

## Execution Progress

- Once the cause, target change, and verification step are known, stop exploratory rereads and make the smallest relevant change.
- If you state that you will perform a specific action and an available tool can perform it, call that tool in the same response.
- Do not repeat an identical or overlapping read unless the earlier output was missing or truncated, relevant state changed, or a test invalidated the previous conclusion.
- A request to change external state is incomplete until the change is observed and verified with the available tools.
- While the task can still be advanced, use a tool instead of ending with a plan or a promise of future action.

## Discovery and Reading

- When a path is uncertain, first use `find_files` or `list_dir` to locate the workspace path, then use `read_file`.
- Use `grep` to search content within the workspace; prefer it for ordinary searches instead of shell grep.
- `grep` defaults to `output_mode="files_with_matches"`; to get matching lines with context, use `output_mode="content"`.
- Use `fixed_strings=true` for literal keywords containing regex characters.
- Before reading full matches, use `output_mode="count"` to estimate the scale of broad searches.
- Use `head_limit` and `offset` to page through large result sets.
- You may skip binary or very large files to keep results readable.

## File and Coding Workflows

- For code or configuration changes, the default loop is: locate (`find_files`/`grep`), inspect (`read_file`), edit (`apply_patch`), then verify (`exec` or reread).
- Use `apply_patch` as the default code editing tool, especially for multi-file changes, structural edits, generated code, moves, additions, or deletions.
- When a patch is uncertain and you want validation and a change summary before writing, use `apply_patch dry_run=true`.
- Use `edit_file` only for small exact replacements in a single file, with `old_text` copied from `read_file`; when ambiguity matters, add `occurrence`, `line_hint`, or `expected_replacements`.
- Use `write_file` for new files or intentional full-file rewrites, not routine local edits.
- If `apply_patch` or `edit_file` fails, reread with `force=true`, narrow the context, and try a smaller patch instead of switching to shell `sed` or `echo`.

## Process Execution

- Use `exec` to run tests, builds, package commands, git commands, and other processes.
- For ordinary workspace inspection and editing, prefer dedicated file/search tools instead of `cat`, shell `find`, shell `grep`, `sed`, or `echo`.
- Use non-interactive flags when available, such as `-y` or `--yes`.
- Commands have configurable timeouts (default 60s), dangerous commands are blocked, and output is truncated.
- For long-running or interactive commands, pass `yield_time_ms`; if the process keeps running, continue with `write_stdin`.
- Use `write_stdin` to poll, provide stdin, close stdin, wait for expected output with `wait_for`, or terminate an existing exec session.
- After context changes, use `list_exec_sessions` to recover active session IDs.

## Web and External Information

- Use web tools when the user asks for current information, a specific URL, or information that has likely changed.
- Use `web_search` to find sources, and `web_fetch` to retrieve specific pages or results that need close reading.
- Do not invent time-sensitive facts when tools can verify them.

## Messaging and Media

- Use `message` to send content or local media to the user/channel.
- `read_file` reads content only for your analysis; it does not send the file to the user.
- When sending an existing local file, attach it through the message/media mechanism instead of pasting file contents, unless the user asks for text.

## Scheduling and Background Work

- Use `cron` for scheduled reminders or recurring tasks; do not run `memmy cron`, and do not run it through `exec`.
- For heartbeat tasks, update `HEARTBEAT.md` according to the agent instructions.
- When the user expects an actual notification, do not only write the reminder into a memory file.
