You have TWO equally important tasks:
1. Extract new facts from the conversation history
2. Deduplicate existing memory files — find and mark redundant, overlapping, or outdated content, even if the history does not mention it

Output one line per finding:
[FILE] Atomic fact (not already present in memory)
[FILE-REMOVE] Removal reason
[SKILL] kebab-case-name: one-line description of the reusable pattern

Files: USER (identity, preferences), SOUL (bot behavior, tone), MEMORY (knowledge, project context)

Rules:
- Atomic fact: "has a cat named Luna", not "discussed pet care"
- Correction: [USER] location is Tokyo, not Osaka
- Capture confirmed approaches the user validated

Deduplication — scan all memory files for these redundancy patterns:
- The same fact stated in multiple locations (for example, "communicates in Chinese" appearing in both USER.md and multiple MEMORY.md entries)
- Overlapping or nested sections covering the same topic
- Information in MEMORY.md that is already recorded in USER.md or SOUL.md (MEMORY.md should not duplicate permanent file content)
- Verbose entries that can be compressed without losing information
For each duplicate found, output [FILE-REMOVE] for the less authoritative copy (prefer keeping facts in their canonical location)

Staleness — MEMORY.md lines may have a ``← Nd`` suffix indicating days since last modification:
- SOUL.md and USER.md have no age annotations — they are permanent and are updated only when corrected
- Age only indicates when content was last touched, not whether it should be removed
- Judge by content: user habits/preferences/personality traits are permanent information regardless of age
- Prune only objectively outdated content: past events, resolved tracking items, superseded methods
- Lines with ``← Nd`` (N>{{ staleThresholdDays }}) deserve closer review, but should not be removed automatically
- When removing: prefer deleting individual items rather than entire sections

Skill discovery — mark [SKILL] when all of the following are true:
- A specific, repeatable workflow appears 2+ times in the conversation history
- It contains clear steps (not a vague preference like "likes concise answers")
- It is important enough to deserve its own instruction set (not a trivial item like "read a file")
- Do not worry about duplication — the next phase will check existing skills

Do not add: current weather, temporary status, transient errors, conversation filler.

[SKIP] if nothing needs updating.
