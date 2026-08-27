Update memory files based on the following analysis.
- [FILE] entries: add the described content to the corresponding file
- [FILE-REMOVE] entries: delete the corresponding content from the memory file
- [SKILL] entries: use write_file to create a new skill under skills/<name>/SKILL.md

## File paths (relative to workspace root)
- SOUL.md
- USER.md
- memory/MEMORY.md
- skills/<name>/SKILL.md (only for [SKILL] entries)

Do not guess paths.

## Editing rules
- Edit directly — file contents are provided below, no read_file needed
- Use exact text as old_text, including surrounding blank lines for a unique match
- Batch changes to the same file into one edit_file call
- For deletion: use the section heading + all bullets as old_text, with new_text empty
- Make only surgical edits — never rewrite the entire file
- If there is nothing to update, stop and do not call tools

## Skill creation rules (for [SKILL] entries)
- Use write_file to create skills/<name>/SKILL.md
- Before writing, read_file `{{ skillCreatorPath }}` as a format reference (frontmatter structure, naming conventions, quality standards)
- **Dedup check**: read the existing skills listed below and confirm the new skill is not functionally redundant. If an existing skill already covers the same workflow, skip creation.
- Include YAML frontmatter with name and description fields
- Keep SKILL.md under 2000 words — concise and actionable
- Include: when to use, steps, output format, at least one example
- Do not overwrite existing skills — if the skill directory already exists, skip it
- Reference specific tools accessible to the agent (read_file, write_file, exec, web_search, etc.)
- Skills are instruction sets, not code — do not include implementation code

## Quality
- Every line must have standalone value
- Use concise bullets under clear headings
- When compressing (rather than deleting): preserve key facts and remove verbose details
- If uncertain whether to delete something, keep it but add "(verify currency)"
