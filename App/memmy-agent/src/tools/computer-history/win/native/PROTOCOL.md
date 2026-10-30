# Windows native capture protocol v1

Status: **Windows-only, native-side protocol, version 1.** It describes the stream written by
`memmy-history-recorder.exe`. It is modeled on the C# validation prototype
(`HistoryProbe`). The [TypeScript adapter](../README.md) validates this native stream and
normalizes it into shared Computer History JSONL. Consumers must use that adapter rather
than treating native snapshots as Mac AX events.

## Transport

- UTF-8 JSON Lines: one JSON object per line, `\n`-terminated, no BOM. Strings are emitted
  as UTF-8 (not `\u` escaped). Unpaired UTF-16 surrogates from UI text become U+FFFD.
- `observe` writes every line to stdout and, with `--output`, to segmented files. `snapshot`
  writes exactly one line. `windows`, `applications` and `catalog` write exactly one line. stderr carries only
  diagnostics: `{"diagnostic":"<code>","detail":"<code or path>"}`. These contain no captured
  content.
- Key order is insertion order (envelope first) but carries no meaning.
- Pointer-sized handles (`hwnd`) and process creation times (`processStart`) are **decimal
  strings**. Compare them as strings or BigInt; never convert them to a JavaScript Number.
  `pid` and counters are JSON numbers (they fit in 2^53).

## Envelope (every `observe` and `snapshot` event)

`applications` is a separate metadata response, without a session envelope:
`{protocol:"memmy.windows.computer-history",version:1,platform:"windows",kind:"applications",applications:[{pid,executable,processStart}]}`.
At most 512 visible-window process identities are returned, with each PID present once.
No title, UIA content, selector or authorization result is included. Discovery never grants
capture permission. The `windows --pid` diagnostic command retains its existing format.

`catalog` is a separate display response, without a session envelope:
`{protocol:"memmy.windows.computer-history",version:1,platform:"windows",kind:"application.catalog",applications:[{executable,name}]}`.
At most 512 canonical local EXE paths are returned. Names come from local Start Menu shortcuts,
then running EXE FileDescription/filename metadata; names are limited to 256 UTF-16 units.
Shortcuts are loaded without resolving or launching them. Missing targets, network paths,
reparse points and helper executables are excluded. Only an existing sibling named by
`Update.exe --processStart` is accepted as a launcher target. Directory enumeration stops after
4096 entries. No PID, creation time, UIA content or capture rule is supplied. This response
cannot replace `applications` instance discovery or serve as a snapshot/observation stream.

| Field | Type | Meaning |
|---|---|---|
| `protocol` | string | Always `"memmy.windows.computer-history"` |
| `version` | number | Always `1` |
| `platform` | string | Always `"windows"` |
| `sessionId` | string | 32 lowercase hex chars; constant for one process run, including across pause/resume and file rotation |
| `sequence` | number | 1, 2, 3, … without gaps within a session (also across segments) |
| `kind` | string | Event kind (below) |
| `timestamp` | string | UTC wall clock, `YYYY-MM-DDTHH:MM:SS.mmmZ` |
| `monotonicMs` | number | Milliseconds since session start (QPC-based; unaffected by clock changes) |

## Event kinds

### `session.started` (sequence 1)
`collector` `{version, pid, testHooks}`, `policyRevision` (SHA-256 hex of the policy file
bytes at start), `options` `{seconds, rotateSeconds, sampleMs, inputHooks, parentPid|null}`,
`segment` `{index, file}` or `null` without `--output`.

### `snapshot`
| Field | Presence | Meaning |
|---|---|---|
| `trigger` | always | `{kinds: [..], count}`. Kinds: `session_start`, `sample`, `resume`, `retry`, `queue_overflow`, `foreground`, `focus`, `name_change`, `value_change`, `show`, `input`, `pointer`, or `explicit` for the `snapshot` command. `count` is the number of coalesced triggers. |
| `context` | always | Window identity object, or **`null` when the target is not named by the policy** (unauthorized apps stay anonymous). |
| `snapshot.status` | always | `ok`, `blocked` (policy/identity refused the read) or `unavailable` (read attempted, failed) |
| `snapshot.reason` | always | `null` for `ok`; otherwise a code (below) |
| `snapshot.elapsedMs` | always | Collector-side duration of this query |
| `snapshot.mode` | `ok` only | `full` (captured tree; complete only when `truncated=false`) or `delta` |
| `snapshot.nodes` | `ok` + `full` | All captured nodes, preorder (root first) |
| `snapshot.added` | `ok` + `delta` | New or changed nodes |
| `snapshot.removed` | `ok` + `delta` | **Keys only** of nodes no longer present. Never content. |
| `snapshot.unchangedCount` | `ok` + `delta` | Number of unchanged nodes |
| `snapshot.focusKey` | `ok` only | Key of the node reporting keyboard focus, or `null` |
| `snapshot.truncated`, `snapshot.truncation` | `ok` only | Whether any budget was hit; codes `max_nodes`, `max_visited`, `max_depth`, `max_text`, `budget_ms`, `traversal_error` |
| `snapshot.stats` | `ok` only | `{visited, emitted, redacted, foreignSkipped, missingProperties, workerElapsedMs}` |
| `snapshot.actions` | `ok` observe with input hooks | At most 64 observed input metadata objects, described below |
| `snapshot.actionOverflow` | with `actions` | The bounded input/trigger queue lost events; counts may be incomplete |

Refused or failed snapshots never carry nodes. In `observe`, an identical `blocked`
result for the same target is counted (`suppressedRepeats`), not re-emitted. Every
`unavailable` result is emitted.

**Baseline rules.** A non-truncated `full` snapshot starts a baseline whose identity is the window
instance (hwnd, pid, processStart), policy revision, foreground/focus generation and pause epoch.
Any change to these, and any non-`ok` result, starts a new `full` snapshot next time. Truncated
captures are always `full`, carry only the nodes actually read, and clear the complete baseline:
they never emit removals or prove that omitted nodes disappeared. The next complete capture is
also `full`. A complete `ok` read with no added/removed nodes and the same focus key is not
emitted (`unchanged` counter), unless actions or action overflow need emitting. Baselines
advance only after a successful emission commit.

### Optional observed actions (`--input-hooks`)

Every action carries `timestamp` (UTC, millisecond precision) and `injected` (boolean).
The hook timestamps represent input observation, not UIA read time. Only actions matching
the authorized snapshot's HWND and foreground/focus generation reach the final commit.
Actions queued during pause or against changed/blocked contexts are discarded. WinEvent
delivery and low-level input are asynchronous; this is bounded evidence, not lossless input
auditing or proof of exact clicked targets. The adapter rejects action timestamps more than
60 seconds old or more than one second ahead of their containing frame.

| `type` | Additional fields | Meaning |
|---|---|---|
| `mouse_click` | `button`: left/right, integer `x`,`y` | Button release at physical pixel coordinates; target/effect unverified |
| `scroll` | `direction`: up/down/left/right, signed nonzero `delta` | Wheel metadata; resulting movement unverified |
| `key_press` | `key`: fixed semantic label | Backspace, Tab, Enter, Escape, navigation, Delete, F1–F12; limited Control or Meta letter shortcuts |
| `text_input` | `pressCount`: 1, `redacted`: true, `unit`: key_press | Printable-key identity erased, including Ctrl+Alt/AltGr; resulting characters/layout/IME unknown |

Key modifier prefixes are ordered `Control+Alt+Shift+Meta+`. Letter shortcuts are limited to
Control with optional Shift and `ACVXYZSFPTWNLR`, or Meta with optional Shift and `DELR`.
Modifier-only/unsupported keys are ignored. Keyboard actions require a captured focused
node with `password=false` and no sensitive/unknown-password redaction; ordinary redacted
Edit controls allow counts but never values. Mouse metadata does not authorize input text.
`injected=true` may be software input and must not be narrated as proven human activity.
The default stream omits these fields. UIA triggers alone never produce action objects.

### Context object
`{hwnd, pid, processStart, executable, dpi, bounds:{left,top,right,bottom}, minimized, title?, generation?}`

- `pid` is the process that owns the HWND (`GetWindowThreadProcessId`), not a
  `MainWindowHandle` lookup. `processStart` is the process creation `FILETIME` (100 ns ticks
  since 1601-01-01 UTC). `executable` is the canonical final path of the running image.
- `bounds` are physical pixels (per-monitor DPI aware v2); `dpi` from `GetDpiForWindow`.
- `title` is present only on `ok` snapshots (read without sending messages to the target).
- `generation` is the collector's foreground/focus generation at query start.

### Node object
| Field | Presence | Meaning |
|---|---|---|
| `key` | always | 16 hex chars; FNV-1a over runtime id, control type, AutomationId, redaction, password state, focus, provider offscreen state, content and parent key. Duplicate keys within a capture are deterministically disambiguated using an ordinal salt; children use the resulting unique parent key. An ancestor change resends its descendants, preserving parent links. Bounds are excluded. |
| `parentKey` | always | Parent's key, `null` for the root |
| `runtimeId` | always | UIA runtime id, dot-joined (may be `""` if unavailable) |
| `controlType` | always | UIA control type programmatic name (`Text`, `Edit`, `Document`, …). Not mapped to macOS AX roles. |
| `automationId` | always | String, possibly empty, at most 256 UTF-16 units |
| `depth` | always | 0 for the root window |
| `focused` | always | Provider `HasKeyboardFocus` |
| `providerOffscreen` | always | Provider `IsOffscreen` flag. **Not proof** of visible pixels. |
| `password` | always | `true`/`false`, or `null` when the provider does not report `IsPassword` |
| `redaction` | when masked | `sensitive_id`, `password`, `edit_control`, `unknown_password`, `unknown_password_structural` |
| `documentStatus` | scoped editor read attempted | `available`, `label_only`, or `read_failed`; participates in the node key when present |
| `className` | Word scope metadata when available | Bounded UIA class name (256 UTF-16 units); producer emits only `_WwG`, `_WwB`, `_WwF`, `OpusApp`; participates in node key |
| `name` | when permitted | UIA `Name` |
| `text` | authorized document region | `TextPattern.DocumentRange` text |
| `visibleText` | authorized document region | Provider-reported visible ranges, `\n`-joined |
| `value` | authorized, focused search field | `ValuePattern.Value` |
| `bounds` | when available | `[left, top, width, height]` physical pixels |
| `missing` | when non-empty | Property names that failed to read |

Text limits count UTF-16 code units (JavaScript `length`). A `redaction` node never has
`name`/`text`/`visibleText`/`value`.

For the VS Code scope, `available` requires Name and Text; a nonempty Name equal to Text
after trimming ASCII space/CR/LF/tab is conservatively `label_only`. This handles localized
unavailable-editor hints without treating successful TextPattern calls as body proof. Missing
Name/Text or failed live authorization yields `read_failed`. Both states omit all four content
fields and use `edit_control`. A genuine body identical to its name is also conservatively
excluded. Worker and TS validators independently check status, scope and content consistency.

### `session.paused` / `session.resumed`
`alreadyPaused` / `alreadyRunning` (boolean; repeated commands are acknowledged idempotently).
By the time `session.paused` is written, in-flight reads have been cancelled, queued triggers
discarded, the foreground generation advanced and the baseline cleared. No `snapshot` appears
between `session.paused` and the next `session.resumed`. The first snapshot after resume is
`full`.

### `segment.started`
First line of every rotated segment: `segment` `{index, file}` and a `counters` object.

### `error`
`code`, `fatal` (boolean) and, for output failures, `channel` (`stdout` | `file`). Codes:
`control_command_unknown`, `control_command_too_long` (non-fatal; the line is not echoed),
`output_write_failed`, `output_flush_failed`, `output_segment_exists`, `output_open_failed` (fatal).
`control_queue_overflow` is fatal: a pause/resume that cannot fit in the bounded control queue
ends collection instead of being silently dropped. Stop/EOF always have sticky priority.

### `session.stopped` (last line)

With `--input-hooks`, `Ctrl+Alt+Shift+R` requests a normal stop with reason
`stop_hotkey`, even while paused or with an unauthorized foreground application.
The chord is control only, not captured text or an action. Synthetic input can
trigger it; automated injection does not prove a physical keyboard acceptance.
`reason` (`stop_command`, `stdin_eof`, `duration_elapsed`, `parent_exited`, `console_control`,
`output_failed`, `control_queue_overflow`, `internal_error`), `hooksDetached`, and `counters`:
`triggers {accepted, coalesced, dropped, discarded, ignoredBackground, ignoredPaused}`,
`queries {started, ok, blocked, unavailable, timedOut, cancelled, truncated, contextChanged,
policyChanged, unchanged, suppressedRepeats}`, `control {pauses, resumes, rejected}`,
`hooks {callbacks, callbackMaxMs}`, `events` (lines written before this one).

## Reason codes

| Code | Status | Meaning |
|---|---|---|
| `policy_unavailable`, `policy_too_large`, `policy_invalid` | blocked | Policy file unreadable (including locked by a writer), over 256 KiB, or failing strict validation |
| `policy_changed` | blocked | Policy bytes differed after the query; output discarded |
| `application_denied` | blocked | Deny list matched (deny wins over allow) |
| `application_not_authorized` | blocked | No rule matched pid + canonical executable (+ hwnd/processStart if given) |
| `browser_unsupported` | blocked | Known browser executable (see README); always refused in this phase |
| `window_unavailable`, `not_top_level`, `process_unavailable`, `identity_unavailable` | blocked | Identity could not be established |
| `not_foreground` | blocked | Target is not the foreground window |
| `context_changed` | blocked | Foreground/focus generation, foreground HWND, search focus or instance identity changed before content commit |
| `foreign_root` | blocked | UIA root belongs to another process |
| `worker_timeout` | unavailable | Worker exceeded `workerTimeoutMs`; it was terminated |
| `worker_failed`, `worker_launch_failed`, `worker_job_failed`, `worker_output_too_large`, `worker_invalid_output`, `worker_invalid_request`, `worker_privacy_violation` | unavailable | Isolation or validation failure; nothing emitted |
| `uia_unavailable`, `uia_root_unavailable`, `uia_error`, `com_unavailable`, `hook_barrier_failed`, `out_of_memory`, `internal_error` | unavailable | Read infrastructure failure |
| `test_gate_failed`, `test_gate_timeout` | unavailable | Test-hooks executable only |

## Policy file (strict JSON, UTF-8, at most 256 KiB)

See `examples/policy.example.json`. Unknown keys, duplicate keys, comments, trailing commas,
wrong types and out-of-range values are rejected. The whole file is rejected, never partially
applied. `observe` refuses to start without a valid policy, and each query re-reads it.

| Key | Required | Rules |
|---|---|---|
| `version` | yes | `1` |
| `applications` | yes | 1–32 exact instance rules; up to 512 when `defaultApplicationBehavior` is `"observe"` |
| `defaultApplicationBehavior` | no | `"observe"` or `"do_not_observe"`; permits the larger binding list only, never a wildcard match |
| `applications[].pid` | yes | integer 1..2^32-1 |
| `applications[].executable` | yes | absolute path (`X:\…` or UNC). It is canonicalized before comparison (case, `/`, 8.3, links). |
| `applications[].processStart` | no | decimal string; when present it must equal the process creation FILETIME |
| `applications[].hwnd` | no | decimal string; when present only this top-level window matches |
| `applications[].searchFields` | no | `[{controlType:"Edit", automationId}]`; value read only while that exact field has focus |
| `applications[].documentRegions` | no | Exact nonempty-ID selectors, or the bounded VS Code / Word / Notepad selectors below; TextPattern body reads only |
| `applications[].sensitiveAutomationIds` | no | blocks the element and its subtree (case-insensitive) |
| `sensitiveAutomationIds` | no | same, for all applications |
| `deny.executables`, `deny.pids` | no | refuse even if an application rule matches |
| `limits` | no | `maxDepth` 1–64 (24), `maxNodes` 1–5000 (400), `maxVisited` ≥ maxNodes, ≤ 20000 (2000), `maxTextChars` 1–200000 (12000), `maxNodeTextChars` ≤ maxTextChars, ≤ 20000 (2048), `queryBudgetMs` 50–10000 (650), `workerTimeoutMs` 200–30000 and > queryBudgetMs (1500) |

Ordinary selectors match control type plus exact **nonempty** AutomationId. Names never grant
permission. One empty-ID exception is `{controlType:"Edit",automationId:"",scope:"vscode.editor"}`
in documentRegions for a bound `Code.exe`. It requires the exact metadata chain
`Edit("") <- Text("") <- Group("") <- Group("workbench.parts.editor")`, with successfully read IDs,
password=false and unredacted ancestors. Native code checks live type/ID/password/PID/sensitive
IDs before and after reading. Worker and TS validators reconstruct the scope independently;
a changed ancestor invalidates the body permission, including in deltas.

With the VS Code scope, generic workbench Names are not collected: search terms can be echoed into
sibling status/live-region Text. Only authorized body or explicitly selected search fields may
carry content. Normal ancestor traversal remains metadata-only.

Another exception is `{controlType:"Document",automationId:"",scope:"word.document"}` for a
bound `WINWORD.EXE`. It requires `Document(_WwG) <- Pane(_WwB) <- Pane(_WwF) <- Window(OpusApp)`
at depths 3, 2, 1, 0, with readable empty IDs, password=false, unredacted ancestors, and root
parent=null. Native before/after checks additionally require same-PID HWNDs, matching real
window classes, exact Win32 parent links and the original root HWND. Worker and TS validators
independently reconstruct the class/type/ancestor evidence; a native boolean is not authority.
Both scopes use documentStatus and suppress descendants after a scoped read attempt, including
read failure. Word draft and print layouts can use the outer Document without a generic empty-ID
wildcard. Complete text and provider-visible text remain distinct.

`{controlType:"Document",automationId:"",scope:"notepad.document"}` is limited to a bound
`Notepad.exe` with `Document(RichEditD2DPT) <- Pane(NotepadTextBox) <- Window(Notepad)` at
depths 2, 1, 0. All three IDs must be successfully read and empty, password=false, with
unredacted ancestors and root parent=null. Native before/after checks verify same-PID HWNDs,
actual Win32 classes and parent links back to the original root. Worker and TS independently
reconstruct the chain. It uses the same documentStatus and descendant suppression rules.
The provider's generic editor label is preserved as a label, never inferred to be a filename.
Normalized `documentEvidence.adapter` is `notepad.document`; it is not native authority.

The normalized JSONL adapter may add `documentContext: "vscode.editor"` only after independently
validating an available VS Code body. This is not an accepted native protocol field. The shared
summary may use its text under an explicit visibility-unconfirmed document-context label;
it must not convert that body into provider-visible text or evidence of user actions.

The host supplies Word `Edit + Body` plus `word.document`, the VS Code scope, and the Notepad scope,
only after app consent/binding, unless documentRegions
is explicitly supplied (including an empty array).

These are additive v1 fields shipped together in the helper and adapter. Older strict clients
can reject them; mixing old helpers/adapters with the new scope is unsupported and fails closed.

The product host compiles its default application scope into PID/path/creation-time rules and
refreshes them as applications open or close. The native collector still rejects every unmatched
instance. Explicit deny rules, known browsers and login/lock/screensaver executables take
precedence over all matching application rules. Policies without the new scope field retain the
32-rule limit and exact-match behavior (`defaultApplicationBehavior` is that application-scope field).

## Differences from the C# validation prototype

| Area | C# `HistoryProbe` | Native v1 |
|---|---|---|
| Envelope | `protocolVersion` only | `protocol` + `version` + `platform` |
| `processStart` | .NET ticks since 0001-01-01 (string) | FILETIME ticks since 1601-01-01 (string) |
| `hwnd` | JSON number | decimal string |
| Roles | mapped to `AXStaticText`/`AXTextField`/… | raw UIA `controlType`; mapping left to a future adapter |
| Redaction | `"[REDACTED]"` placeholder strings | `redaction` code; content fields omitted |
| Delta | `{mode, lines}` / `{removed, added}` text lines inside a `detail` string | structured `mode`/`nodes`/`added`/`removed` (keys only) |
| Content events | `kind` = trigger name, `degraded` for failures | `kind: "snapshot"` with `status` + `reason`; trigger in `trigger.kinds` |
| Unauthorized targets | silently skipped | `blocked` event with `context: null`, repeats suppressed |
| Browser | URL/private-state logic with a test `allowUnknownPrivate` switch | all known browsers `browser_unsupported`; no URL, no switch |
| Office/VS Code fixture selectors | name/AutomationId fixture lists per app | Word Body + bounded document scope and bounded VS Code editor scope; generic nonempty-ID selectors remain available |
| Credential regex scrubbing | yes (`password=…` → `[REDACTED]`) | not implemented natively; left to the consumer's redaction |
| Segment manifest | `.segments.json` sidecar | no sidecar; segment names are deterministic, each starts with `segment.started` |
| Mouse trigger detail | coordinates and button recorded | no coordinates, no key codes |
