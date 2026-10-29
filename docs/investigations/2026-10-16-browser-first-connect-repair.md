# Browser extension first-connection repair

Baseline: `8968ede64ae33638da0d096b8197ec04ed2a6e03`. Branch: `codex/browser-first-connect-20261016`. Extension: `1.0.12`.

## Cause and scope

The [Mac investigation](2026-10-16-browser-first-connect-forensics.md) found a registered, current extension and a surviving Chrome process, but a 19-minute discontinuity in the reconnect alarm schedule. Its profile databases reopened when Chrome became foreground; connection was then observed. Process liveness was an insufficient readiness check, and the tool had neither an on-demand browser recovery step nor a bounded handshake wait before suggesting installation. The exact event that made the historical profile inactive is not recoverable from the available records; a last-window close remains an inference.

This repair addresses the observed process/profile distinction and separately reproduced lifecycle failures. It does not require an alarm to fire at an exact deadline.

## Behavior

- A normal connected extension returns immediately. Internal browser pages remain a distinct unsupported-page state.
- An explicitly requested Chrome/Edge with a verified installed, enabled extension and running process can be opened through the OS to revive its profile. The request supplies no URL, profile flags, developer-mode changes, or extension reload.
- Only an interactive current task can request that recovery. System/cron tasks and contexts that disable interactive computer use do not wake the browser. Ended tasks cancel their pending metadata request, wake request, and connection wait.
- Recovery waits up to 45 seconds for the requested browser's handshake, then refreshes its page inventory. The 45 seconds is the handshake-wait budget, not a promise that the entire tool finishes in 45 seconds. Metadata/launcher/refresh operations have their own bounds.
- Unknown installation/enable/process states remain unknown; a short 2-second grace may catch an in-progress handshake without OS activation. A confirmed disabled or absent extension is not automatically enabled or installed.
- A page-list response timeout is `unresponsive`, distinct from disconnection. Stale page claims are not offered; recovery does not terminate a shared socket or cancel another chat's work.
- Browser startup/installation events restore the reconnect alarm; missing or malformed alarms are repaired with bounded retries. Optional History initialization failure leaves History disabled while allowing the execution bridge to reconnect.
- The ready-handshake timeout is 5 seconds. Negotiated heartbeat recovery probes before replacing an apparently stale socket after system sleep. Older gateways remain compatible.
- Extension reload exceptions no longer permanently suppress another update attempt.
- At most 24 connection events are retained in extension diagnostics and gateway diagnostics. Their fields are limited to stage, time, extension version, local port, failure class, and close code. Page content, URLs, titles, credentials, user paths, and error strings are excluded.

## Cross-platform coverage

The connection, alarm, worker, handshake, heartbeat, cancellation, and state logic is shared by Chrome/Edge on Mac and Windows. macOS opens the named application through `/usr/bin/open -a`; Windows uses the installed executable with an empty argument list and no shell. Installation probing handles modern Chromium records with no legacy `state` field, disabled records, corrupted/incomplete metadata, and permission failures without conflating them.

All edits and build outputs are in the dedicated worktree. No patch was copied into the primary checkout or other release worktrees. Existing frontend settings and release work remained separate. Excel tools, Excel reading/writing, and Excel-specific guidance were not changed.

## Verification

Regression fixtures first failed on the old implementation, including startup/alarm failures, slow ready handshakes, History initialization isolation, reload retry, discovery recovery, and cancellation. Independent review also reproduced and repaired close-during-start and cross-turn cleanup races.

Integrated validation on 2026-10-16 passed **389 tests across 18 files**:

| Group | Files | Passing tests |
| --- | --- | --- |
| Agent discovery, target routing, embedded IPC, bridge, router, authenticated status, turn lifecycle | 8 | 169 |
| Extension packaging/lifecycle, passive History, focus, input guard, OS wake commands | 5 | 146 |
| Installation/process metadata, recovery IPC, embedded selection IPC | 4 | 69 |
| Embedded command contracts | 1 | 5 |

Agent and desktop Shell TypeScript checks and emitted builds passed. Local contracts/backend/interface dependencies were built in this worktree. Extension JavaScript syntax, project-version verification, and `git diff --check` passed. These are source/build/fixture results; no real Windows runtime or installed-package GUI acceptance is claimed.

Two independent reviewers inspected connection privacy, OS wake commands, installation permission failures, cancellation and cross-turn ownership. Their reproduced findings were corrected and covered by regressions: close during bridge startup, an old discovery finally clearing a new turn's cancellation set, unknown enablement causing OS activation, EACCES being mistaken for absence, and a page-discovery timeout bypassing recovery.

## User-owned package acceptance

No installed application or personal browser configuration was replaced during this task. The checks below must be run against a package containing this commit and extension 1.0.12; automated fixtures do not establish installed-app or real Windows GUI acceptance.

| Scenario | macOS | Windows |
| --- | --- | --- |
| Browser process survives but no ordinary browser window is open | Keep Chrome/Edge running, close its last window, then explicitly request it in Memmy. Confirm a browser window opens and the task connects through the extension. | Exercise Chrome background mode and Edge Startup Boost/background state. Confirm the requested browser/profile opens and connects. |
| Memmy restart while browser stays open | Quit/reopen Memmy; request the same browser and confirm reconnect before page action. | Repeat with the installed Windows package. |
| Long system sleep/resume | Resume with a connected browser and confirm recovery without duplicate page actions. | Repeat after Windows sleep/resume. |
| Installed but disabled extension | Confirm it is reported as disabled and is not auto-enabled or reinstalled. | Same check. |
| Missing extension or inaccessible profile metadata | Confirm missing and unknown are distinct and no false installation claim is made. | Include an ACL-denied metadata case without changing an everyday profile. |
| Chrome and Edge together / multiple chats | Name each browser and verify it uses the correct account/page. Stop a task during recovery and confirm it does not later activate a browser. | Same check; verify no hidden console window opens. |

If a failure recurs, capture the gateway `[browser-connection]` events and the extension's `memmyConnectionDiagnostics` record to distinguish profile wakeup, listener startup, port/ready timeout, heartbeat failure, and successful connection. No browsing content is needed for this diagnosis.
