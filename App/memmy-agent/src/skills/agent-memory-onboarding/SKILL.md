---
name: agent-memory-onboarding
description: On-demand guide for a Memmy GUI task that connects an explicitly named local Agent, installs or removes its rendered Memmy Skill, imports its latest 500 complete turns, and records a reusable automatic-sync recipe.
metadata: {"memmy":{"manualOnly":true}}
---

# Agent Memory Onboarding

Connect unknown local Agent frameworks through investigation at runtime. Do not add a framework-specific parser to Memmy. Inspect the installed Agent, infer its storage format, produce a temporary normalized manifest, and save a declarative recipe that Memmy can reuse without another Agent session.

This is a button-triggered guide, not startup initialization. Run it only when the current task explicitly names `$agent-memory-onboarding`. Never discover Agents, install Skills, or scan history during Memmy startup.

## Required Input

The task must include:

- `operation`: `connect`, `install`, or `uninstall`
- `source_id`: the exact Memmy Agent source id
- `agent_name`: the framework name entered by the user
- The task may also include a known `data_path`

Never guess or replace `source_id`.

## Operation Routing

### Connect

1. Identify the exact conversation surface the user is using, then discover that surface's installation, configuration, native Skill or instruction mechanism, and history storage.
2. Render and install the full Memmy Skill for the exact user-entered Agent name.
3. Verify the installed file and `memmy-memory health`, then call `memmy_agent_source` with `action="set_skill_status"` and `skill_installed=true`. Include `data_path` only after verifying that it belongs to the same active conversation surface.
4. Normalize available history and import the latest 500 complete user/assistant turns.
5. Build and save a reusable sync recipe for the same native history store. The recipe must reproduce the same stable ids, roles, text, and timestamps without AI.

### Install

Discover the Agent's native Skill location, render the Agent-specific Skill as described below, and install that exact rendered file. Then call:

```text
memmy_agent_source(
  action="set_skill_status",
  source_id="<source_id>",
  skill_installed=true
)
```

Include `data_path="<verified history root>"` only when the path is proven to belong to the same active conversation surface.

### Uninstall

Find and remove only the Memmy-managed Skill directory or marked Memmy instruction block. Preserve every unrelated file and instruction. Then report `skill_installed=false` with `memmy_agent_source`.

## Discovery Procedure

Search narrowly before widening:

1. Check the executable, package metadata, help output, and the Agent's own config.
2. Enumerate distinct product surfaces before choosing a store. Desktop products may contain a remote web chat, a native coding Agent, a background daemon, and a browser profile with unrelated histories.
3. Compare each surface with current activity: running process arguments, recently modified data, UI origin or workspace, generated artifact locations, and conversation-store timestamps.
4. Check exact-name variants beneath `~/.config`, `~/.local/share`, `~/Library/Application Support`, `~/Library/Caches`, and dot-directories in the home directory.
5. Inspect recently modified candidate files and database schemas. Common containers are JSON, JSONL, SQLite, LevelDB-backed browser storage, and per-project transcript directories.
6. Confirm the format from multiple records. Identify conversation id, message id or stable record position, role, content, and timestamp.
7. Reject a candidate that is empty or stale while another surface shows recent user activity. Never infer "no history" from the first plausible database.
8. Do not mix a Skill mechanism from one product surface with history from another.
9. Do not scan the whole filesystem, dependency caches, model caches, logs unrelated to conversations, or secret stores.

Use read-only commands during discovery. A small one-off extraction script in the Memmy workspace is allowed after the format is understood; it is an execution artifact, not a permanent framework adapter.

Cloud-backed surfaces may keep only encrypted caches or generated artifacts locally while the actual conversation remains on a remote service. Do not read credentials or browser secret stores to bypass that boundary. If no complete local conversation records can be verified, report discovery as incomplete, do not create an empty manifest, do not call `import_manifest`, and leave the scan pending for a later retry.

## Install the Full Memmy Skill

Before writing anything into the target Agent, call:

```text
memmy_agent_source(
  action="render_skill",
  source_id="<source_id>"
)
```

The tool reads the persisted user-entered Agent name for `source_id`, deterministically shell-quotes it, replaces every source placeholder in the full template, and returns `skillPath`. Do not pass a replacement value or perform placeholder replacement yourself.

- Prefer the Agent's native Skill directory and copy the returned file to `memmy-memory/SKILL.md`.
- If it has no native Skill system, insert the rendered file body into its global Agent instructions between `<!-- memmy-memory:start -->` and `<!-- memmy-memory:end -->`.
- Do not install the unrendered reference template.
- Preserve existing files and use the Agent's documented frontmatter conventions.
- Verify the installed content contains the user-entered Agent name and no `{{SOURCE_ARG}}`.
- Verify `memmy-memory health` before marking installation successful.

## Normalize, Import, and Enable Automatic Sync

Read [history-manifest.md](./references/history-manifest.md) before extracting. Write JSONL under the Memmy workspace, one normalized message per line.

For first import call:

```text
memmy_agent_source(
  action="import_manifest",
  source_id="<source_id>",
  manifest_path="<workspace JSONL path>",
  mode="initial_subset",
  data_path="<primary history root>"
)
```

The tool selects at most the 500 most recent complete turns and records the oldest selected turn's timestamp as the permanent sync boundary. If fewer than 500 exist, it records the oldest available complete turn.

An initial import requires at least one complete user/assistant turn. An empty store has no meaningful 500th-turn boundary: do not call `import_manifest`, do not record a synthetic epoch boundary, and do not mark the scan successful. Recheck that the selected store belongs to the active conversation surface. If the store is genuinely new, leave the scan pending until the first complete turn exists.

After the initial import succeeds, read [sync-recipe.md](./references/sync-recipe.md), create a recipe for the native history store, and call:

```text
memmy_agent_source(
  action="save_sync_recipe",
  source_id="<source_id>",
  data_path="<primary native history root>",
  sync_recipe={...}
)
```

This call validates the recipe by reading the native store and persists it only when it yields complete user/assistant turns. Never point the recipe at the temporary normalized manifest. Do not save a recipe for a stale, unrelated, generated-artifact-only, or unverified store.

Later GUI syncs do not invoke this Skill or start a Memmy Agent session. The backend applies the saved recipe, keeps complete turns strictly after the permanent initial boundary, deduplicates stable message ids, and adds the resulting L1 memories automatically.

Only mark the Skill installed after its file is verified. Skill installation and history discovery are separate outcomes. Do not mark a scan successful if the active history surface is unresolved, the manifest is empty, or manifest generation or import failed.

## Completion

Report:

- discovered history path and format;
- installed or removed Skill path;
- selected, written, deduplicated, and failed counts from the tool;
- recorded sync boundary;
- saved recipe format and automatic-sync readiness;
- any files or conversations skipped and why.

Do not expose tokens, credentials, raw private logs, or full conversation contents in the final response.
