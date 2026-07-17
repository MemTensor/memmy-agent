---
name: update-setup
description: One-time setup wizard for the memmy upgrade skill. Triggers: setup update, configure update, 切设置更新, 初始化更新.
---

# Update Setup

Generate a personalized upgrade skill for this workspace.

## Step 1: Check Existing

Use `read_file` to check if `skills/update/SKILL.md` already exists in the workspace.

If it exists, ask the user: "An upgrade skill already exists. Reconfigure?" Wait for the user's reply. If no, stop here.

## Step 2: Current Version and Install Clues

Use `exec` to run `memmy --version`. Tell the user the current version.

Then collect install clues with `exec`. These commands are best-effort; if one fails,
keep going and show the useful output:

```
command -v memmy || true
npm list -g memmy-agent --depth=0 || true
pnpm list -g memmy-agent --depth=0 || true
yarn global list --pattern memmy-agent || true
```

Summarize what you found in one short paragraph. Use the clues only to suggest a
likely install method. Do not treat them as confirmation.

## Step 3: Confirm Required Inputs

CRITICAL: Do not write `skills/update/SKILL.md` until the install method is
explicitly confirmed by the user. The install method must come from a user
answer or confirmation, not from inference alone. If you cannot get a clear
answer, stop and ask the user to rerun this setup when they know how memmy was
installed.

Treat a request like "generate upgrade config", "set up updates", or "use
update-setup" as the goal, not as confirmation of the install method. Install
clues are only hints for the question summary; never choose `npm`, `pnpm`,
`yarn`, or `source` from clues alone. In the initial setup turn, write
`skills/update/SKILL.md` only if the user message already contains an explicit
install method and proxy answer. Otherwise, ask Question 1 and stop.

Hard stop rule: after collecting install clues without an explicit install
method from the user, do not call `write_file` for any path ending in
`skills/update/SKILL.md` in that same assistant turn. This remains true when
`update-setup` is part of a larger task that also creates other skills or runs
external installers. Finish the safe parts, ask Question 1, and wait for a later user
message before continuing.

Ask the user the questions below, one at a time, in your response text. Wait for
the user's reply before proceeding to the next question. If you cannot get a clear
answer, stop without writing the skill.

**Question 1 — Install method:**

```
question: "I found these install clues: <SUMMARY>. Which update method should this workspace use?"
options: ["npm", "pnpm", "yarn", "source (git clone)", "not sure"]
```

If the user selected `not sure`, explain the difference between the options and
stop. Do not generate the upgrade skill.

If the user selected `source (git clone)`, ask for the local checkout path:
`question: "Where is your memmy source checkout? Enter an absolute path or a path relative to this workspace:"`.

**Question 2 — Proxy:**

```
question: "Do you need an HTTP proxy to reach the npm registry or GitHub?"
options: ["no", "yes"]
```

If yes, ask one more time for the proxy URL: `question: "Enter proxy URL (e.g. http://127.0.0.1:7890):"`.

## Step 4: Generate Skill

Determine the upgrade command from the install method:

| Method | Command |
|--------|---------|
| npm | `npm install -g memmy-agent@latest` |
| pnpm | `pnpm add -g memmy-agent@latest` |
| yarn | `yarn global add memmy-agent@latest` |
| source | `cd <SOURCE_CHECKOUT> && git pull && npm install && npm run build` |

For source installs, quote the source checkout path if it contains spaces.

Determine the preflight check from the install method:

| Method | Preflight check |
|--------|-----------------|
| npm | `command -v npm && node --version` |
| pnpm | `command -v pnpm && node --version` |
| yarn | `command -v yarn && node --version` |
| source | `test -d <SOURCE_CHECKOUT> && test -d <SOURCE_CHECKOUT>/.git && test -f <SOURCE_CHECKOUT>/package.json` |

For source installs, quote the source checkout path in the preflight check if it
contains spaces.

Build the skill content. If proxy is configured, add `export http_proxy=URL` and `export https_proxy=URL` lines before the upgrade command.

Use `write_file` to write `skills/update/SKILL.md` with this content:

```
---
name: update
description: "Upgrade memmy to the latest version. Triggers: upgrade memmy, update memmy, 升级memmy, 更新memmy."
---

# Update Memmy

1. (If proxy configured) Set proxy: `export http_proxy=URL && export https_proxy=URL`
2. Use `exec` to run the preflight check: <PREFLIGHT_CHECK>. If it fails, stop and tell the user to rerun `update-setup` because the saved install method no longer matches this environment.
3. Use `exec` to run the upgrade command: <UPGRADE_COMMAND>
4. Use `exec` to verify: `memmy --version`
5. Tell the user the new version. Say: "Run `/restart` to restart memmy and apply the update. If `/restart` is unavailable in this channel, restart the memmy process manually."
```

## Step 5: Confirm

Tell the user: "Upgrade skill created. Say 'upgrade memmy' when you want to update."
