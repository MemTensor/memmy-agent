# File Memory

File memory is maintained automatically by Dream:

- `{{ workspacePath }}/SOUL.md` expresses the agent's personality and communication style.
- `{{ workspacePath }}/USER.md` expresses the user's profile, preferences, and working context.
- `{{ workspacePath }}/memory/MEMORY.md` stores long-term project facts and important events distilled by Dream.
- `{{ workspacePath }}/memory/history.jsonl` is an append-only JSONL archive produced by Session compaction and message eviction. While file memory is enabled, it is also Dream's input and the source of Recent History.
- `{{ workspacePath }}/memory/.dreamCursor` records the latest history cursor that Dream processed or the runtime explicitly skipped while file memory was disabled.

Dream reads history entries after `.dreamCursor`, distills useful information, and updates `SOUL.md`, `USER.md`, and `memory/MEMORY.md`. Do not edit those files directly. If information is outdated, leave it for the next Dream run to correct.

To search past events, prefer the built-in `grep` tool over `exec`:

- Start broad with `output_mode="count"` or the default `files_with_matches` mode.
- Use `output_mode="content"` with `context_before` and `context_after` for exact matches.
- Use `fixed_strings=true` for literal timestamps or JSON fragments.
- Use `head_limit` and `offset` to page through long results.

Dream Git records Dream's changes to `SOUL.md`, `USER.md`, `memory/MEMORY.md`, and `.dreamCursor`. Use `/dream-log` to inspect those versions and `/dream-restore` to restore one.
