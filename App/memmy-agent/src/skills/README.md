# Memmy Skills

This directory contains the built-in skills bundled with `memmy-agent`.

## Skill Format

Each skill is a directory containing a `SKILL.md` file with:

- YAML frontmatter (name, description, metadata)
- Markdown instructions for the agent

When skills reference large local documentation or logs, prefer memmy's built-in
`grep` tool to narrow the search space before loading full files.
Use `grep(output_mode="count")` / `files_with_matches` for broad searches first,
use `head_limit` / `offset` to page through large result sets,
and `grep(glob="*.md")` to filter by file name pattern.

## Attribution

These skills are adapted from [OpenClaw](https://github.com/openclaw/openclaw)'s skill system.
Runtime metadata uses memmy-agent's own `metadata.memmy` namespace.

## Available Skills

| Skill                     | Description                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent-memory-onboarding` | Connect an explicitly named local agent, install its Memory integration, import initial history, and save an automatic-sync recipe. |
| `cron`                    | Schedule reminders and recurring tasks.                                                                                             |
| `github`                  | Work with issues, pull requests, CI runs, and the GitHub API through the `gh` CLI.                                                  |
| `goal`                    | Manage sustained objectives with explicit goal state and completion.                                                                |
| `image-generation`        | Generate images and iteratively edit saved image artifacts.                                                                         |
| `skill-creator`           | Create, review, and maintain `memmy-agent` skills.                                                                                  |
| `summarize`               | Summarize URLs, local files, podcasts, and YouTube videos.                                                                          |
| `tmux`                    | Remote-control interactive terminal sessions.                                                                                       |
| `ui-craft`                | Design and implement browser-visible interfaces with visual QA.                                                                     |
| `update-setup`            | Configure a workspace-specific Memmy upgrade skill.                                                                                 |
| `weather`                 | Retrieve current weather and forecasts without an API key.                                                                          |
