Extract key facts from this conversation. Output only items that match the following categories, and skip everything else:
- User facts: personal information, preferences, clearly expressed opinions, habits
- Decisions: choices made, conclusions reached
- Solutions: working methods discovered through trial and error, especially non-obvious methods that succeeded after failed attempts
- Events: plans, deadlines, notable occurrences
- Preferences: communication style, tool preferences

Priority: user corrections and preferences > solutions > decisions > events > environment facts. The most valuable memories prevent the user from repeating themselves.

Skip: code patterns that can be inferred from source, git history, or anything already recorded in existing memory.

Output concise bullets, one fact per line. Do not include a preface or commentary.
If nothing noteworthy happened, output: (nothing)
