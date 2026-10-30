# memmy-history-recorder (Windows native core)

Minimal native capture chain for Memmy Computer History on Windows, covering stages 2 and 3:
window/instance identity, isolated UI Automation (UIA) reads, privacy filtering, event
scheduling, lifecycle and segmented JSONL output. It is a standalone C++20 executable with no
.NET, GUI framework or OCR dependency.

The executable writes the Windows-native [protocol v1](PROTOCOL.md). The adjacent
[TypeScript adapter and product driver](../README.md) validate and normalize it into
shared Computer History recordings. The native program remains independently buildable.
Windows NSIS builds now ship the production helper outside ASAR with its license notices;
signing and broader real-application compatibility validation remain separate work.

## Layout

```
CMakeLists.txt            build (static CRT, /W4 /WX, separate PDBs)
cmake/NlohmannJson.cmake  pinned + SHA-256 verified nlohmann/json 3.12.0 (single header)
src/common/               pure logic: policy, classification, protocol, baseline, queue, CLI, UTF-8
src/win/                  Win32/UIA: identity, hooks, worker host, UIA reader, output, commands
src/main.cpp              entry point
tests/unit/               pure unit tests
tests/fixture/            controlled Win32 fixture (two windows, sentinels, stdin command channel)
tests/integration/        CTest harness that drives the real executables against the fixture
examples/policy.example.json
PROTOCOL.md               stream and policy specification
THIRD_PARTY_NOTICES.md
```

## Command line

```
memmy-history-recorder help | --help
memmy-history-recorder version | --version
memmy-history-recorder windows --pid N
memmy-history-recorder applications
memmy-history-recorder catalog
memmy-history-recorder snapshot --hwnd N --policy FILE
memmy-history-recorder observe --policy FILE [--output FILE] [--seconds N] [--rotate-seconds N]
                               [--sample-ms N] [--parent-pid N] [--input-hooks]
```

- `windows` lists the visible top-level windows of a PID with their identity (diagnostic only).
- `applications` lists at most 512 visible-window process identities (unique PID): executable
  path and creation FILETIME only. It never reads window titles or UIA content, and does not
  authorize or begin recording. The product uses these identities for explicit application
  selection and for binding selected paths to current instances.
- `catalog` supplies local installed/running application display names, from Start Menu `.lnk`
  metadata and EXE version resources. It never launches a link or supplies capture identities.
  Enumeration and output are bounded; failures in product discovery fall back to EXE names.
- `snapshot` performs one authorized read of a foreground window and prints one `snapshot`
  event. Exit code 0 means `ok` and 3 means refused or unavailable.
- `observe` records the foreground window while it is authorized. It runs for `--seconds`
  (default **30**, max 86400) and rotates `--output` every `--rotate-seconds` (default 600).
  Control lines on stdin are `pause`, `resume` and `stop`; stdin EOF stops. With
  `--parent-pid`, the session also ends when that process exits (including forced
  termination). `--input-hooks` adds `WH_KEYBOARD_LL`/`WH_MOUSE_LL` and bounded action
  metadata attached to authorized snapshots; no ordinary typed text is retained.
- Exit codes: 0 ok, 1 internal, 2 usage/configuration (including an invalid policy or an
  existing output file), 3 snapshot not ok, 4 collector already running in this session,
  5 capture infrastructure unavailable (hooks / Job Object), 6 output write failure.
- `__worker` is internal: it reads one JSON request on stdin and writes one response.

Recording never starts implicitly. `observe` requires a valid policy, and only windows that
policy names are read.

## Architecture

Password checks combine UIA `IsPassword` with native HWND owner, Edit/RichEdit/Windows Forms
class and `ES_PASSWORD` metadata before any Name/Value/Text read. A native password result
overrides a provider's false assertion even when the provider reports a Pane. Unknown state
never grants text permission; the final native check discards content and prunes children if
the state becomes unsafe. Windowless elements retain the existing provider-based rules.

```
collector process (observe / snapshot)
  main thread      scheduler: drains triggers, debounces (100 ms), throttles (>=200 ms apart),
                   samples (--sample-ms), runs one query at a time, writes JSONL
  hook thread      Win32 message loop; SetWinEventHook (foreground, minimize, desktop switch,
                   focus, name, value, show; out-of-context, own process skipped) and optional
                   low-level hooks. Callbacks only bump the foreground/focus generation, push
                   {kind, hwnd, generation, tick, optional fixed-size input metadata} into
                   a bounded (256) queue (only non-action notifications coalesce) and
                   signal an event.
  control thread   reads stdin lines (256-byte cap); bounded queue, sticky priority stop/EOF;
                   cancellable, detached safely on shutdown
  Job Object       KILL_ON_JOB_CLOSE, 1 active process, 1 GiB memory; workers are created
                   suspended already inside the job (PROC_THREAD_ATTRIBUTE_JOB_LIST), verified
                   with IsProcessInJob, then resumed (any failure = no read)
        |
        | private anonymous pipes (explicit PROC_THREAD_ATTRIBUTE_HANDLE_LIST), bounded,
        | drained concurrently; request = identity + policy bytes snapshot
        v
worker process (same exe, "__worker", no windows, COM MTA)
  re-parses the policy, re-checks identity/authorization/foreground, then walks the UIA control
  view from the authorized HWND with a metadata-only cache request; content is read per node
  only after classification. Per-call UIA connection/transaction timeouts = queryBudgetMs.
```

A query is checked after the worker returns and again after serialization, immediately before
content emission. A barrier round-trip through the hook thread dispatches WinEvents already
queued there. The final policy read holds a handle denying writes/deletion/replacement until
the content write finishes.

- the foreground/focus generation is unchanged, so A→B→A is caught even when both ends are equal
- the same HWND is foreground
- the window instance identity (hwnd, pid, process creation time, canonical path) is identical
- the policy file bytes are identical
- no pause/stop/EOF/parent-exit control is pending, and authorized search focus is unchanged

The collector also re-validates the worker's JSON against the policy (privacy invariants,
tree shape, budgets) before anything is written.

### Current window capture model

As of 2026-10-16, captureText defaults to true. Applications and browsers share capability-based UIA reads, independent of exact control roles or application-specific ancestor shapes. The authorized foreground HWND and process instance are still checked before and after capture. Hosted descendants may belong to other PIDs; traversal remains scoped to that HWND subtree.

Explicit passwords and sensitive AutomationIds prune their subtrees. Missing IsPassword is metadata uncertainty, not a blanket refusal. Positive native password styles remain checked before and after reads. Credential redaction runs before shared history persistence.

Focus branches and documents are prioritized. Provider-visible ranges are read before bounded document context. Missing names or equal Name/Text do not invalidate generic text. Failed TextPattern reads can fall back to ValuePattern, LegacyIAccessible and window-scoped MSAA; failed fields do not discard successful fields. Raw View is attempted within the same total deadline if Control View provides no text. Window-scoped Chromium accessibility requests do not change global system settings or user application profiles.

### Browser metadata enhancement

Browser names never deny generic capture. Chrome and Edge additionally attempt Document URL enrichment; metadata is attached when it matches the captured document identity; URLs available before and after capture must agree. Missing metadata does not block content. Capture includes private, guest and unknown modes in this development stage. Windows observes unknown URLs; recognizable URLs still pass through configured website rules. macOS defaults are unchanged.

Run `node App/memmy-agent/src/tools/computer-history/win/native/tests/integration/browser-smoke.mjs` for owned Chrome synthetic pages, or add `--browser=edge`. This checks page navigation, scrolling, tabs, persistence and summary evidence under the new generic contract. The Electron smoke remains an independent engine-level diagnostic, not third-party application coverage.

## Build

Requirements: Windows 10/11 x64, Visual Studio 2022 v143 (MSVC 19.4x), Windows SDK 10.0.26100,
CMake ≥ 3.25, Ninja. The first configure downloads `json.hpp` (pinned URL + SHA-256). Offline
builds can pass `-DMEMMY_NLOHMANN_JSON_HPP=<path>`; the same hash is enforced, and there is no
unverified fallback.

From an x64 developer prompt:

```
cmake -S App/memmy-agent/src/tools/computer-history/win/native -B <build>/release -G Ninja ^
      -DCMAKE_BUILD_TYPE=Release -DMEMMY_HISTORY_TEST_ARTIFACTS=<artifacts>/release
cmake --build <build>/release
ctest --test-dir <build>/release --output-on-failure
```

Or use the wrapper, which locates Visual Studio itself and builds outside the repository by
default:

```
pwsh scripts/internal/win/history-recorder-native.ps1 -Configuration Release -Test
```

Release links the CRT statically (`/MT`), with `/guard:cf /CETCOMPAT /OPT:REF /OPT:ICF /Brepro`.
PDBs are separate (`/PDBALTPATH:%_PDB%`). The executable imports only Windows system DLLs:
`KERNEL32`, `USER32`, `ole32`, `OLEAUT32` and `bcrypt`.

`memmy-history-recorder-testhooks.exe` is a separate test build (`MEMMY_HISTORY_TEST_HOOKS=1`)
with a worker sleep and a named-event gate for race tests. The production executable rejects
these options and the worker request fields, and contains no gate code.
The test build also has a post-serialization commit gate and a file-flush fault injector.

## Tests

The shared service, frontend and optional production-EXE lifecycle baseline has
a separate [validation entry and Mac handoff](../../VALIDATION.md). The native
CTest suite below includes foreground-dependent cases outside that baseline.

- `unit`: strict policy parsing and ranges, deny precedence, browser refusal, node
  classification, worker-response privacy validation, identity string precision, UTF-8/JSON
  escaping, truncation, timestamps, baseline/delta, bounded queue, CLI, argument quoting,
  control line splitting, and the example policy.
- `win.boundaries`: saturated control queue followed by EOF/stop; fail-closed pause/resume
  overflow; hook thread cleanup after
  owner destruction; policy revision lease blocking writes/replacement; close/rotation flush failures.
- `integration.*`: one CTest per case (see `CMakeLists.txt`) against the in-repo fixture.
  Policies authorize only the fixture's exact PID and executable. Lifecycle cases authorize
  only the harness process, which has no windows, so a user's foreground app is refused
  anonymously. Foreground cases activate the fixture and verify `GetForegroundWindow()`. They
  exit 77 (CTest *skipped*) when the desktop is locked or foreground cannot be obtained, and
  fail if focus leaves the fixture mid-case. Evidence lands in
  `MEMMY_HISTORY_TEST_ARTIFACTS/<case>/<timestamp-pid>/`.
  Commit races exercise policy rewriting, foreground and same-window focus A→B→A,
  search-to-password focus, pause and command floods after serialization. Partial-baseline
  recovery and observable flush failure are also covered.
  `stop_hotkey` injects Ctrl+Alt+Shift+R into the controlled fixture and verifies clean
  collector shutdown both running and native-paused, with no authorized application.
  It verifies synthetic input, not a person's physical keyboard.
- Do not interact with the desktop while foreground cases run.

### Local acceptance (2026-10-02)

Historical native-core baseline, before product discovery and action metadata, verified
independently on Windows x64 with VS Build Tools 2022 17.14.41,
MSVC 19.44.35229, Windows SDK 10.0.26100.0, CMake 3.31.6 and Ninja 1.12.1:

| Configuration | CTest result | Production executable |
|---|---|---|
| Release | 32 passed, 0 failed, 0 skipped (38.92 s) | 557,056 bytes (544 KiB) |
| Debug | 32 passed, 0 failed, 0 skipped (40.70 s) | 3,307,520 bytes |

Each suite contains 39 pure unit cases in one entry, one Win32 boundary-test entry, and
30 integration entries. The separate Release PDB is 11,816,960 bytes and is not a runtime
dependency. `dumpbin` confirms only `ole32.dll`, `OLEAUT32.dll`, `bcrypt.dll`, `KERNEL32.dll`
and `USER32.dll`; CFG, NX, ASLR and high-entropy virtual addresses are enabled. The production
executable rejects the commit gate and flush fault options with exit 2 and empty stdout; the
gate continuation marker is absent from production and present in the separate test build.

The 2026-10-02 product-integration build is 572,928 bytes (559.5 KiB) in Release.
Release and Debug CTest each completed with 16 passed, 16 explicitly skipped, no failures:
the skipped cases require foreground activation that this desktop session did not grant.
They do not establish action/content compatibility. New pure tests cover printable/AltGr
identity erasure, safe key labels, action queue counts and focus/visibility delta updates.
The TypeScript suite separately passed the real product service lifecycle with the production
EXE and a controlled fixture, without relying on foreground activation.

Reproduce the tested configuration from the repository root in PowerShell:

```powershell
& .\scripts\internal\win\history-recorder-native.ps1 -Configuration Release -Test `
  -BuildRoot D:\memmy-cpp-env\native-core-review -ArtifactsRoot D:\memmy-cpp-env\native-core-review-artifacts
& .\scripts\internal\win\history-recorder-native.ps1 -Configuration Debug -Test `
  -BuildRoot D:\memmy-cpp-env\native-core-review -ArtifactsRoot D:\memmy-cpp-env\native-core-review-artifacts
```

Final CTest logs are `D:\memmy-cpp-env\claude-native-core\codex-release-verified.log` and
`codex-debug-verified.log`. Detailed test outputs are in each build's
`Testing/Temporary/LastTest.log`; policies and captured fixture streams are under
`D:\memmy-cpp-env\native-core-review-artifacts`. Evidence was preserved across the review runs.

An earlier Debug prototype run had one `observe_lifecycle` failure after resume; its root
cause was not established and its original stream was unavailable. Current assertions permit
only an explicitly missing/degraded field to recover on a later sample; returned stale content
still fails. The final suites above passed with those assertions. This is not evidence of
long-duration or broad application compatibility.

## Out of scope / known limitations

- The TypeScript adapter, shared service and Windows UI are integrated (see
  [product entry](../README.md)). EXE packaging and installer delivery remain pending.
- Browser URL enhancement currently recognizes Chrome and Edge; other applications use generic capture.
- No production Office/WPS/VS Code body adapters. Only the generic exact-AutomationId
  `documentRegions` selector exists, validated against a RichEdit document in the fixture.
- Selectors cannot match on names. Global ValuePattern/TextPattern reads do not exist by design.
- Hang handling is tested in two ways: a real UI-thread hang in the fixture (caught by the UIA
  per-call timeout) and a simulated hung worker (killed by the collector). Not every provider's
  behaviour is covered.
- The A→B→A check depends on out-of-context WinEvents being delivered to the hook thread
  before the barrier message. A foreground/focus flip whose WinEvent is still in flight inside the
  window manager at that instant is a residual race. The endpoint-HWND and identity checks
  still apply.
- Win32 has no atomic transaction combining foreground/focus validation with a file/pipe write.
  A transition immediately after the final check remains a race; the collector does not claim
  a stronger guarantee. Native HWND search focus is additionally checked with `GetGUIThreadInfo`.
- Output writes are synchronous. A consumer that keeps stdout open without draining it can
  apply backpressure and delay acknowledgements; consumers must continuously drain stdout/stderr.
- `providerOffscreen`/`visibleText` are what the provider reports, not proof of visible pixels.
- Not covered here: real IME input, other locales, multi-monitor DPI changes mid-query,
  elevated or protected target processes (reported `process_unavailable`), secure desktop or
  lock-screen transitions beyond the desktop-switch generation bump, long soak (1 h+), and
  memory/CPU profiling.
- No credential regex scrubbing natively. Consumer-side redaction remains responsible for it.
- The native CLI owns only its protocol and deterministic segment naming. The integrated
  TypeScript service owns recording manifests, retention and summaries.
