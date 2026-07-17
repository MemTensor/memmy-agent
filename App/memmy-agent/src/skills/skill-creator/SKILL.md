---
name: skill-creator
description: Create, edit, improve, tidy, review, audit, or restructure memmy-agent skills and SKILL.md files.
---

# Skill Creator

Use this skill when creating or maintaining a memmy-agent skill.

## Core Principles

Keep the skill small enough to load quickly. Put only the essential workflow in `SKILL.md`; move detailed reference material into `references/`, reusable deterministic code into `scripts/`, and output assets into `assets/`.

Write for another agent that is already capable. Include the procedural details, constraints, commands, schemas, and examples that would be annoying or risky to rediscover.

## Skill Shape

A skill is a directory with one required file and optional resources:

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

`SKILL.md` must contain YAML frontmatter followed by Markdown instructions.

Required frontmatter:

```yaml
---
name: my-skill
description: Do the specific workflow. Use when the agent needs to handle concrete trigger cases.
---
```

Supported memmy-agent frontmatter fields:

- `name`: lowercase letters, digits, and hyphens only.
- `description`: the trigger text that decides when the skill is useful.
- `metadata`: optional memmy-agent runtime metadata.
- `always`: optional boolean for skills that should always load.
- `license`: optional license label.
- `allowed-tools`: optional tool guidance for consumers.

Use only `metadata.memmy` for runtime metadata:

```yaml
metadata:
  memmy:
    always: true
    requires:
      bins: ["gh"]
      env: ["GITHUB_TOKEN"]
```

## Creation Workflow

1. Clarify the real use cases and triggering phrases.
2. Pick a short hyphen-case name.
3. Create `<workspace>/skills/<skill-name>/SKILL.md`.
4. Add only the resource directories that are actually needed.
5. Run the validator.
6. Test any scripts by executing them on realistic inputs.

Create files directly. There is no required init scaffold command for memmy-agent skills.

## Writing SKILL.md

Put all trigger information in the frontmatter `description`. The body is loaded only after the skill triggers, so a "when to use this skill" section in the body is too late to help discovery.

Use the body for:

- A short operating procedure.
- Commands that should be run exactly.
- References to bundled files and when to read them.
- Constraints that prevent common mistakes.

Avoid:

- README, changelog, installation guide, or process notes inside the skill root.
- Placeholder text such as TODO, "fill me in", or example-only resource files.
- Duplicating long reference material in both `SKILL.md` and `references/`.

## Resource Guidance

Use `scripts/` for repeatable operations where deterministic behavior matters. Prefer Python, shell, or other scripts that can run through an explicit interpreter command.

Use `references/` for large instructions, schemas, API notes, policies, or examples that should be read only when relevant.

Use `assets/` for templates, images, fonts, sample documents, or other files that are consumed as output resources rather than read into context.

## Validation

Run the bundled quick validator before considering a skill ready:

```bash
python3 {baseDir}/scripts/quick-validate.py <skill-dir>
```

Replace `{baseDir}` with the path to this `skill-creator` directory. The validator checks the required frontmatter, memmy-agent metadata namespace, name format, placeholder descriptions, and root file organization.

If validation fails, fix the reported issue and run the command again.
