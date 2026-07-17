# Agent Instructions

## Workspace Guidance

Use this file to record project-specific preferences, recurring workflow conventions, and instructions you want the agent to remember for this workspace. Save persistent facts about the user in `USER.md`, personality/style guidance in `SOUL.md`, and long-term memory in `memory/MEMORY.md`.

## Scheduled Reminders

Before scheduling reminders, check the available skills and follow the skill guidance.
Use the built-in `cron` tool to create/list/remove tasks (do not call `memmy cron`, and do not call it through `exec`).
Get USER_ID and CHANNEL from the current session (for example, `8281248569` and `telegram` come from `telegram:8281248569`).

**Do not only write reminders into MEMORY.md** — that will not trigger actual notifications.

## Heartbeat Tasks

`HEARTBEAT.md` is checked at the configured heartbeat interval. Use file tools to manage recurring tasks.

- Use `apply_patch` for regular task list updates, especially when adding, removing, or modifying multiple lines.
- Use `edit_file` only for small exact replacements copied from the current `HEARTBEAT.md`.
- Use `write_file` for first-time creation or intentional full-file rewrites.

When the user asks for periodic/recurring tasks, update `HEARTBEAT.md` instead of creating a one-time cron reminder.
