# Synthetic document capability diagnostics

This harness answers **where a known body marker disappears**. It is not an installed-App,
model, browser, or long-running compatibility acceptance test. Use only isolated synthetic
documents: the diagnostic probe can read an explicitly named body that production policy
does not authorize. Never point it at personal documents or ordinary browsing sessions.

The four independently retained layers are:

1. `system-uia.json`: native UIA TextPattern/DocumentRange from exact synthetic selectors,
   plus metadata, HRESULTs, truncation and the current production classifier's decision.
   Matched bodies also report `GetVisibleRanges` HRESULTs, count and individual ranges
   (at most 64 ranges / 2048 UTF-16 units, with `visibleRangesLimited`), independently
   of the recorder. Compare these with native `visibleText` and the actual summary input;
   a complete DocumentRange does not prove that the summary receives that complete text.
2. `native.jsonl`: unchanged stdout bytes from the **production** recorder, strictly reparsed.
3. `normalized.json`: return values of the actual `SnapshotNormalizer.normalizeEvents()`
   before the production writer consumes them.
4. `events.jsonl`: the actual `WindowsHistoryRecorder` / `RecordingWriter` file, read after exit.

The runner uses temporary transparent taps in its own Node process, restores them in `finally`,
and rejects test-hook binaries. It does not synthesize native events, replay them as live
capture, patch production behavior, or authorize unrelated applications. `inputHooks` is off.
The separate C++ probe target exists only under `MEMMY_HISTORY_BUILD_TESTS`; packaging builds
with tests disabled and never stages this probe.

## Build and verify the harness

From the repository root, build with the existing native script (omit `-ProductionOnly`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/internal/win/history-recorder-native.ps1 -BuildRoot D:/memmy-history-qa/build -JsonHeader D:/memmy-cpp-env/native-core-deps/json.hpp
npm run test:history-capability
node --import tsx scripts/internal/win/history-capability-fixture.mjs D:/memmy-history-qa/build/release D:/memmy-history-qa/fixture-attempt-01
```

Use your own absolute paths. The pinned JSON header is optional when network fetching is
available. Fixture checks need an unlocked interactive desktop and run sequentially. The five
controls are: body capture across all layers; absent selector; wrong production selector;
wrong diagnostic selector while production still succeeds; target deliberately in background.
Passwords, ordinary input and sensitive subtree markers must stay out of all production layers.
The deliberately invalid foreground case is a successful **negative control**, not a capture pass.

## Real application procedure

Create a short synthetic file with a unique marker **only in its body**, never in the filename
or title. Open it alone in the target window. For editors use isolated profiles, disable
extensions, and record the exact accessibility setting and visible status. Do not change the
user's everyday profile. Use screenshot-only desktop observations before the first capture;
accessibility inspectors can themselves activate providers. Even then, record other active
accessibility clients and do not claim a pristine cold start without controlling them.

Example case manifest (replace the current HWND, EXE and exact observed title):

```json
{
  "syntheticOnly": true,
  "hwnd": "123456",
  "executable": "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  "title": "memmy-capability-word.rtf  -  兼容性模式 - Word",
  "marker": "MEMMY-CAPABILITY-WORD-BODY-20261007",
  "bodyIds": ["Body"],
  "rule": {},
  "uiAutomationTextInspectionBeforeCase": false
}
```

`bodyIds` and/or `bodyNames` select only diagnostic Document/Edit regions. Names must match
exactly, including compatibility-mode suffixes. Neither is a new production permission.
`rule` accepts only existing `documentRegions`, `searchFields`, `sensitiveAutomationIds`.
The runner binds PID, creation time, canonical executable and HWND itself; the rule cannot
override identity. By default an empty `rule` means **no document selectors**, preserving the
original negative control. Set `useApplicationDefaults: true` to call the real
`compileWindowsPolicy()` with an explicit app rule and the observed binding, including the
current Word / VS Code defaults. Explicit `documentRegions: []` still disables defaults.
Compare these modes to distinguish missing product configuration from native capability.

`rangeGeometry: true` additionally records `GetBoundingRectangles` for the matched DocumentRange
and up to eight lines (256 characters each). Every moved line is checked against DocumentRange
endpoints before reading; providers may otherwise move into adjacent controls. Geometry is
diagnostic evidence only and does not change production visibility or summary inputs. Empty
rectangles do not prove a line is absent from the screen. ClassName, native window class and HWND
metadata help evaluate app-specific document ancestry without granting production permission.

```powershell
node --import tsx scripts/internal/win/history-capability.mjs --case D:/memmy-history-qa/word.json --native-bin D:/memmy-history-qa/build/release/memmy-history-recorder.exe --probe-bin D:/memmy-history-qa/build/release/memmy-history-capability-probe.exe --report-dir D:/memmy-history-qa/word-attempt-01
```

Every report directory must be new. An external foreground watcher spans the entire case,
records WinEvent transitions (including away-and-back), samples every 5 ms, and verifies
identity/title before and after. Invalid conditions invalidate attribution. The runner executes
production first, then the raw probe; repeat cases document warm-provider behavior. Production
keeps its default 650 ms query / 1500 ms worker budgets. Diagnostic traversal uses 4000 ms by
default (2000 nodes, depth 40, 2048 UTF-16 units per matched body), with an external 20 s process
limit. These are different budgets; raw success does not prove production latency or completeness.

For a packaged-runtime controlled call, run this same runner with the package's Electron in
Node mode (`ELECTRON_RUN_AS_NODE=1`) and add `--runtime-root` pointing to
`resources/app.asar/dist/runtime/memmy-agent/dist/tools/computer-history/win`. No tsx is needed
in that mode: imports use the actual bundled JavaScript. `--native-bin` must equal the helper
resolved by the bundled resolver; an explicit poisoned override is ignored. Metadata records
the runtime path and helper hash. This tests installed components, not Desktop UI or a real
model request, and intentionally leaves `installedAppAcceptance: false`.

## Interpret evidence, not exit codes alone

- `four_layers_present`: this marker reached every layer in this controlled case.
- `native_policy_exclusion_confirmed`: raw body exists; the same RuntimeId occurs in production
  without body text; the unchanged production classifier denies document text.
- `native_gap_needs_investigation`: raw text exists but the node was not correlated. Investigate
  traversal, budgets, provider changes and foreign-process handling before blaming policy.
- `adapter_gap` / `writer_gap`: marker disappeared after native output / after normalization.
- `product_present_probe_inconclusive`: product succeeded but the diagnostic selector failed.
- `system_probe_inconclusive`: no body proof from the diagnostic. **Not “Windows unsupported”.**
- `precondition_invalid`, `harness_or_capture_error`, `privacy_failure`: investigate separately.

Run collector cases serially. `capture.json` preserves the native exit code, signal and bounded
stderr (64 KiB). Exit 4 plus the structured `collector_already_running` diagnostic invalidates
the test precondition even when foreground and process identity are valid; it is not a UIA
capability gap. Retain the failed attempt, stop the collector owned by the other test normally,
and rerun into a fresh directory. Never stop an unrelated user recording to make a test pass.

Marker attribution checks both the bounded DocumentRange and successful GetVisibleRanges
results of the selected synthetic body; `markerSources` records them separately. A marker near
the end of a long document can be absent from the probe's bounded DocumentRange while present
in a visible range and every production layer. Neither result proves actual pixel visibility.
Keep screenshots, mode/settings observations and production-first ordering distinct from UIA
evidence. A welcome/login overlay, hidden launch, stale desktop-tool state or tool permission
failure is a harness issue, not evidence that the product cannot capture the application.

An absent AutomationId is a valid UIA observation; it is not an API error. Individual HRESULTs
and provider placeholders must be inspected even when TextPattern advertises availability.
Do not infer completeness from one marker or from `truncated: false`. For a failed first attempt,
retain it, record the correction, and use a new directory. A case without `expected` is exploratory;
exit 0 only means the harness ran under valid conditions. Its conclusion may still be inconclusive.
Use `expected` for repeatable controls and inspect `expectationMet` plus all per-snapshot warnings.

Actual dated findings and next implementation gates are in [VALIDATION.md](../../../../VALIDATION.md).
