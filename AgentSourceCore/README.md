# @memmy/agent-source-core

Shared native-turn parsers for Memmy agent-history import. The hook or plugin
path and the offline agent-source scan both read the same on-disk record, emit
the same `SourceTurn`, and submit it through `completeSourceTurn`. Identity,
tool pairing, and session binding are therefore the same on both channels.

This package is a workspace library. `App/backend` and `Memory` each own their
SQLite or filesystem adapters and installers. They must not fork a second copy
of the turn logic.

## Why this package exists

The write contract is shared across agents. A completed native turn has a
stable identity that can be rebuilt from that agent's own files. The realtime
hook or plugin is the primary writer. The offline scan fills gaps when a hook
misses, times out, or never ran. Neither path may invent a second L1 for the
same turn, and a scan must not patch an L1 that already exists.

Agent-specific parsers stay independent because each product persists a
different transcript. Shared helpers stay small: staging, `callId` pairing,
secret redaction at the reader boundary, and `buildSourceTurnRequest`.

A turn is complete only when the native record says so. Missing completion
time, open tools, or an unresolved profile keep the turn pending. `answer` may
be empty when a finished tool already holds the result.

## Architecture

```text
agent disk record
        │
        ▼
  AgentSourceCore reader  ── SourceTurn (source, profileId, conversationId, turnId, …)
        │
        ├─ hook / plugin ──► POST /api/v1/source-turns/complete  channel=hook
        └─ offline scan  ──► completeSourceTurn                  channel=agent_source_scan
                                        │
                                        ▼
                         source_turn_captures + Session / Episode / L1
```

| Rule | Meaning |
| --- | --- |
| One durable artifact | Hook and scan reconstruct the turn from the same files. A hook-only id is a locator, not the primary key. |
| One write API | Both channels call `completeSourceTurn`. The scan must not bypass it with `addMemory`. |
| Stable identity | `turnId` and `profileId` come from immutable native fields. Mutable session-level agent names are not a fallback. |
| Shared session | Memory binds `${source}-memory-${conversationId}`. Do not add source-specific session aliases. |
| Tool pairing | Pair calls and results by a stable `callId`. Do not pair by array position. |
| Frozen L1 | A later channel arrival reuses the capture (`existing`). It does not rewrite L1 content. |
| Pending, then fill | If the realtime path cannot read a complete turn, record `pending`. The scan writes the same `turnId`. |

## Current agents

| Source id | Native record | Shared reader | Typical realtime entry |
| --- | --- | --- | --- |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | `readCodexRollout` / `readCodexSourceTurn` | Codex hook |
| `cursor` | Cursor `state.vscdb` composer and bubble rows | `readCursorComposer` / `readCursorSourceTurn` | Cursor hook |
| `claude_code` | `~/.claude/projects/**/*.jsonl` | `readClaudeCodeSession` / `readClaudeCodeSourceTurn` | Claude Code hook |
| `opencode` | OpenCode `session` / `message` / `part` SQLite | `readOpencodeSessions` / `readOpencodeSourceTurn` | OpenCode plugin |
| `openclaw` | OpenClaw transcript SQLite | `readOpenclawTranscripts` / `readOpenclawSourceTurn` | OpenClaw plugin |
| `hermes` | Hermes `state.db` rows | `readHermesSessions` / `readHermesSourceTurn` | Hermes plugin |
| `deepseek_harness` | DeepSeek Harness session event logs | `readDeepseekHarnessEvents` / `readDeepseekHarnessSourceTurn` | DeepSeek Harness plugin |

Skill-only agents (WorkBuddy, Pi, QwenWork) have no hook or offline-scan
artifact that can produce a `SourceTurn`. They are outside this package.

Database-backed readers take an injected query object (`CursorVscdbSource`,
`OpencodeSource`, `HermesSource`, `OpenclawTranscriptSource`). App/backend
uses `node:sqlite`. Memory uses `better-sqlite3`. Only the queries differ.

## Layout

```text
AgentSourceCore/
  package.json              Workspace package @memmy/agent-source-core
  tsconfig.json             Production build (excludes tests)
  vitest.config.ts          Test include: src/tests/**/*.test.ts
  README.md
  src/
    index.ts                Public exports plus scan-store message types
    source-turn.ts          SourceTurn, staging, pairing, request builder
    secret-redactor.ts      Reader-boundary secret redaction
    jsonl-lines.ts          JSONL helper for file-backed agents
    codex-source-turn.ts
    cursor-source-turn.ts
    claude-code-source-turn.ts
    opencode-source-turn.ts
    openclaw-source-turn.ts
    hermes-source-turn.ts
    deepseek-source-turn.ts
    deepseek-session-files.ts
    tests/
      tsconfig.json         noEmit typecheck for tests
      *.test.ts
```

Consumers (not in this package):

| Package | Role |
| --- | --- |
| `App/backend/src/adapters/outbound/agent-source/*` | Discovery, driver-specific readers, scan adapters |
| `App/backend/src/adapters/outbound/skill-writer/*` | Hook, plugin, and skill installers |
| `Memory/src/agent-source/adapters/*` | The same readers on the Memory scan runtime |
| `Memory/src/agent-source/integration/*` | Generated hook and plugin scripts |
| `Memory/src/service/session/session-turn-service.ts` | `completeSourceTurn` persistence |

## Adding an agent

Do this only when the agent has a durable record that both the realtime path
and a later scan can read. Prove the following from source, real files, or a
failing test before writing production code:

1. Which file or SQLite tables are the shared artifact.
2. How `conversationId` and `turnId` are computed on both channels.
3. Where tool calls and results get a stable `callId`.
4. Which native fields mean "this turn is finished" versus still open.

Then keep the change slice small:

1. Add `${agent}-source-turn.ts` that yields staged `RawSourceMessage` values
   and a `read*SourceTurn` helper for the just-finished turn.
2. Reuse `stageSourceTurnMessages`, `pairSourceToolCalls`, `selectSourceTurn`,
   and `buildSourceTurnRequest`. Redact at the reader boundary, not in public
   `completeTurn`.
3. Add thin wrappers in App/backend and Memory that open the native store and
   inject queries. Do not copy the parser.
4. Point the hook or plugin at the same `read*SourceTurn`. If the turn is not
   complete, leave it pending.
5. Point the scan ingest at `completeSourceTurn(..., "agent_source_scan")`.
6. Add parser tests, both-driver tests when the store is SQLite, and a
   hook-then-scan / scan-then-hook capture test that expects `stored` then
   `existing` with one `source_turn_captures` row.

If a generated Python plugin also builds a `SourceTurn`, it must omit the same
null fields and apply the same redaction as TypeScript. A serialization
mismatch becomes a `conflict`.

### Do not

- Design a second identity, fuzzy time-window dedup, or post-hoc L1 edit.
- Use hook-only request ids, mutable `session.agent`, or "main" as a hidden
  profile default when the native record has no agent.
- Treat `time.created` as completion, or complete a turn that still has
  pending or running host tools.
- Widen `sanitizeTurnCompleteRequest` / public `completeTurn` to compensate
  for one agent.
- Add a shared normalizer framework, move this package under `App/backend`,
  or mix formatting and dependency upgrades into the agent slice.
- Assume a new agent matches Codex finish, profile, or tool semantics.
- Bring skill-only agents into this path without a shared disk contract.

## Testing

Run commands from the repository root. Backend and Memory tests build this
package first.

```bash
npm test -w @memmy/agent-source-core
npx tsc -p AgentSourceCore/src/tests/tsconfig.json --noEmit
npm test -w @memmy/backend -- src/adapters/outbound/agent-source src/adapters/outbound/skill-writer
npm test -w @memmy/memory -- tests/agent-source-opencode-reader.test.ts tests/service/session/source-turn-opencode-structured.test.ts tests/service/session/source-turn-capture.test.ts tests/service/session/turn-tool-pairing.test.ts
```

`source-turn-capture.test.ts` can abort the Vitest worker on Node 24 while
closing `better-sqlite3` statements. That is an environment limit. Split the
file by test-name filters if the whole file exits non-zero; do not describe
grouped passes as a stable whole-file run.

Parser tests belong in `src/tests`. They should cover a completed turn, an
incomplete or pending turn, missing identity, and hook/scan identity equality.

## Development

```bash
npm run build -w @memmy/agent-source-core
npm run typecheck -w @memmy/agent-source-core
npm test -w @memmy/agent-source-core
```

`main` and `types` point at `dist/src`. After changing a reader, rebuild this
workspace before running App/backend or Memory tests that import the package.
