# My Tool — Practical Examples

Concrete scenarios showing when and how to use the my tool effectively.

## Diagnosis

### "Why can't you search the web?"
```
→ my(action="check", key="webConfig.enable")
  → false
→ "Web search is disabled. Add web.enable: true to your config to enable it."
```

### "Why did you stop?"
```
→ my(action="check", key="maxIterations")
  → 40
→ my(action="check", key="lastUsage")
  → {"prompt_tokens": 62000, "completion_tokens": 3000}
→ "I hit the iteration limit (40). The task was complex. I can ask the user if they want to increase it."
```

### "What model are you running?"
```
→ my(action="check", key="model")
  → 'anthropic/claude-sonnet-4-20250514'
```

## Adaptive Behavior

### Large codebase analysis
```
→ my(action="check")
  → contextWindowTokens: 200000
→ my(action="set", key="contextWindowTokens", value=262144)
  → "Set contextWindowTokens = 262144 (was 200000)"
→ "I've expanded my context window to handle this large codebase."
```

### Switching to a faster model for repetitive tasks
```
→ my(action="set", key="model", value="anthropic/claude-haiku-4-5-20251001")
  → "Set model = 'anthropic/claude-haiku-4-5-20251001' (was 'anthropic/claude-sonnet-4-20250514')"
→ "Switched to a faster model for these batch tasks."
```

## Cross-Turn Memory

### Remembering user preferences
```
# Turn 1: user says "keep it brief"
→ my(action="set", key="userStyle", value="concise")
  → "Set scratchpad.userStyle = 'concise'"

# Turn 3: new topic
→ my(action="check", key="userStyle")
  → 'concise'
  (adjusts response style accordingly)
```

### Tracking project context
```
→ my(action="set", key="activeBranch", value="feat/auth")
→ my(action="set", key="testFramework", value="vitest")
→ my(action="set", key="hasDocker", value=true)
```

## Budget Awareness

### Token-conscious behavior
```
→ my(action="check", key="lastUsage")
  → {"prompt_tokens": 58000, "completion_tokens": 12000}
→ "I've consumed ~70k tokens. I'll keep my remaining responses focused."
```
