# macOS browser first-connection investigation — 2026-10-16

## Scope and conclusion

This is a read-only investigation of the installed application and the affected Chrome profile. Times below use Asia/Shanghai (UTC+08:00). No personal browser windows were opened, closed, reloaded, or controlled for this investigation; no application was restarted and no profile or installed application files were changed. The only new file is this report in the isolated repair worktree. It contains connection/process metadata and hashes, not page content, credentials, browsing history, or screenshots.

The extension was installed and its registered worker matched the application bundle before the first failed tool call. The Chrome main process was running throughout. The first failed call fell inside a 19-minute discontinuity in the extension's persisted reconnect-alarm schedule. At 13:08:32–33, Chrome became foreground, its existing profile's service-worker and extension-state databases reopened, an extension renderer started, and its alarm schedule resumed. The bridge was connected by the next observation at 13:09:25.

These facts establish that an installed extension and a running Chrome process did not imply a live extension runtime/profile or a live bridge connection. They strongly support recovery when Chrome's profile was reactivated. They do **not** identify the exact historical trigger that made that profile/runtime inactive. In particular, the surviving records do not directly prove the last-window close, App Nap, a worker crash, or a particular WebSocket error. A causal regression reproduction of a repair must be reported separately from this historical evidence.

## Evidence inputs

Only the affected extension's records were selected from profile data. Chrome databases were read as files without opening them for writing or acquiring their live locks.

| Input | Selected metadata |
| --- | --- |
| `/Applications/Memmy.app/Contents/Resources/browser-extension/manifest.json` and `background.js` | Extension version, connection lifecycle, source hash |
| `$HOME/Library/Application Support/Google/Chrome/Default/Secure Preferences` | Only `extensions.settings.mhodbgbbgalbhehapffidmdegokpoaom` installation, worker-registration, and registered-event fields |
| `$HOME/Library/Application Support/Google/Chrome/Default/Service Worker/Database/000003.log` | Only registration/resource records for that extension origin; LevelDB log/write batches and protobuf fields decoded in memory |
| `$HOME/Library/Application Support/Google/Chrome/Default/Service Worker/ScriptCache/c8aa3755356478d6_0` | Exact inclusion check against bundled `background.js`; no other cached scripts exported |
| `$HOME/Library/Application Support/Google/Chrome/Default/Service Worker/Database/LOG` and `LOG.old` | Database reopening metadata |
| `$HOME/Library/Application Support/Google/Chrome/Default/Extension State/000280.log` | Only `mhodbgbbgalbhehapffidmdegokpoaom.alarms`; selected alarm schedule values |
| `$HOME/Library/Application Support/Google/Chrome/Default/Extension State/LOG` and `LOG.old` | Database reopening metadata |
| `$HOME/.memmy/webui/websocket_cb3cc85c-6324-41ec-b7a3-4061889a4114.jsonl` | Tool names, timestamps, requested Chrome app identity, connection-state results |
| `$HOME/Library/Application Support/Memmy/startup.log` | Gateway startup and permission-relaunch timestamps |
| `ps` process metadata | Chrome main/network/storage/extension-renderer process creation times |
| macOS unified log and `pmset -g log` | Bounded Chrome activity-state and system sleep/display events |

The inspected application was Memmy 1.2.3, with extension 1.0.11. The current Google Chrome version was 155.0.8059.80. Source comparison baseline for the repair worktree was commit `8968ede64ae33638da0d096b8197ec04ed2a6e03`; this report does not claim the complete application bundle was byte-identical to that commit.

## Verified installation and worker state

- Extension ID: `mhodbgbbgalbhehapffidmdegokpoaom`.
- Installed path: `/Applications/Memmy.app/Contents/Resources/browser-extension`.
- `first_install_time`: `13436598213767741`, corresponding to 12:23:33.767741 on 2026-10-16.
- `last_update_time`: `13436598213862933`, corresponding to 12:23:33.862933 on 2026-10-16.
- `has_started_service_worker`: `true`.
- `service_worker_registration_info.version`: `1.0.11`.
- No `disable_reasons` entry was present in this extension's record at inspection time. This observation does not reconstruct every prior enable/disable state.
- Registered worker events included `alarms.onAlarm`, debugger and tab events, and window-focus/removal events.
- The latest surviving service-worker registration was registration ID 900, version ID 2636, with `is_active=true`.
- Its `last_update_check_time` was 12:23:33.906765. This field is an update-check timestamp, **not** a worker-start or WebSocket-connect timestamp.
- The bundled `background.js` was 115735 bytes, SHA-256 `520c5a51fbfe4f5e5efccab23f4ba98c24e51aa83f4e1d9ef7d6b31ee5a6473e`.
- That complete file occurred verbatim in the registered worker's source cache. Its resource record contained the same SHA-256, case-insensitively. The source cache and service-worker database log last modified at 12:23:33.

The `Secure Preferences` file itself last modified at 13:08:57.830312. File-level modification time alone is not evidence that this extension was reinstalled or its worker source updated then; the selected extension's install/update/registration and cached-source records remained as above.

The protobuf interpretation was checked against Chromium's [service-worker database schema](https://chromium.googlesource.com/chromium/src/+/d60984dee3a5102a2f7b42f0f6ac329b900bee7b/components/services/storage/service_worker/service_worker_database.proto): fields 1/4/5 identify registration/version/active state and field 7 is a Windows-epoch update-check time. This is a schema interpretation of persisted records, not a live service-worker debugger observation.

## Timeline

| Local time | Evidence | What it establishes |
| --- | --- | --- |
| 12:13:55.114 | Memmy startup log: gateway settled | Memmy had an earlier gateway instance before the extension install and failed task. |
| 12:21:21 | Chrome PID 41805 creation time | The main Chrome process was already running. |
| 12:21:25 | Chrome network PID 41813 and storage PID 41814 creation times | Those utility processes also preceded the failed task and survived the later recovery. |
| 12:23:33 | Preferences, service-worker registration and source cache | Extension 1.0.11 was installed and registered with the current bundle's worker source. |
| 12:43:36.557–716 | Both databases' `LOG.old` | An earlier opening of the same service-worker/extension-state databases. |
| 12:49:33.907011 | Persisted reconnect-alarm next `scheduledTime`, LevelDB sequence 649312 | Last next-schedule value before the long discontinuity. It is not a recorded callback timestamp. |
| 12:49:34.162–268 | Chrome AppKit activity logs | Chrome resigned active; automatic-termination eligibility/state-restoration metadata changed. These records do not directly count windows. |
| 12:53:09 | `pmset`: display off | Display turned off. No system Sleep/Wake event was found in the bounded interval. |
| 13:06:54 | `pmset`: display on | Display returned before the first tool call. |
| 13:07:35.243 | `browser_list_tabs` | `connectedBrowsers: []`. |
| 13:07:45.963 | `computer_use_list_apps` | Google Chrome was listed as running; the result did not provide a live extension/profile connection check or window count. |
| 13:08:02.872 | Memmy startup log | macOS Privacy & Security requested a permission restart. |
| 13:08:07.930 | Memmy startup log | Relaunch after cleanup. |
| 13:08:10.911 | Memmy startup log | Relaunched gateway settled. |
| 13:08:26.465 | `browser_list_tabs` | Still `connectedBrowsers: []`. |
| 13:08:32 | Chrome extension renderer PID 49753 creation time | A new extension renderer began around recovery. The process flag does not independently identify its extension. |
| 13:08:32.905–906 | Service-worker database `LOG` | Database reopened and recovered/reused its existing log. |
| 13:08:32.961 | RunningBoard Chrome state | Chrome became `UserInteractiveFocal`. |
| 13:08:33.082–102 | Extension-state database `LOG` | Database reopened and recovered/reused its existing log. |
| 13:08:33.894 | `computer_use_get_app_state` completed for Google Chrome | Native Chrome inspection/activation coincided with the profile/database recovery; completion is later than the OS foreground transition. |
| 13:08:33.907011 | Persisted reconnect-alarm next `scheduledTime`, sequence 649313 | The next value jumped 19 minutes from sequence 649312. |
| 13:09:03.907011; 13:09:33.907011 | Alarm sequences 649314; 649315 | Regular 30-second next-schedule progression resumed. |
| 13:09:25.383 | `browser_list_tabs` | `connectedBrowsers: ["chrome"]`; an internal new-tab page was unsupported. This bounds observed recovery, not its exact connection timestamp. |
| 13:10:14.158 | `browser_list_tabs` | Two ordinary pages were ready through the extension. |

The 13:08 permission restart occurred **after** the 13:07:35 failure. It may interrupt an existing connection or delay subsequent recovery, but cannot cause an earlier observation. It must not be presented as the original failure's cause.

## Alarm and profile recovery evidence

The relevant persisted alarm was `memmy-reconnect`, with `periodInMinutes=0.5`, `persistAcrossSessions=true`, and `granularity="30000000"`. Consecutive journal entries for this key included:

| LevelDB sequence | Next scheduled local time |
| --- | --- |
| 649309 | 12:48:03.907011 |
| 649310 | 12:48:33.907011 |
| 649311 | 12:49:03.907011 |
| 649312 | 12:49:33.907011 |
| 649313 | 13:08:33.907011 |
| 649314 | 13:09:03.907011 |
| 649315 | 13:09:33.907011 |
| 649316 | 13:10:03.907011 |

There were no intermediate entries for this key between consecutive sequences 649312 and 649313 in the parsed live log. Chromium's [AlarmManager implementation](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/api/alarms/alarm_manager.cc) dispatches an elapsed alarm, moves a periodic alarm's next schedule past any missed intervals, then persists the updated alarm list. Therefore this discontinuity supports missed/deferred polling or an unloaded/reopened alarm context; it does not timestamp a JavaScript callback or prove that the callback executed successfully. The existing state files do not contain their own write wall-clock timestamp.

Both profile databases reopened at the same recovery boundary despite the Chrome main, network, and storage processes surviving. This is stronger evidence of profile/runtime reinitialization than a generic claim that a single WebSocket retry finally succeeded. A previous schedule jump from 12:38:03 to 12:44:03 also coincided with the prior database reopening at 12:43:36.

Chromium supports releasing a regular profile when its last browser window closes while the application process can remain alive; see its [profile lifecycle feature definition](https://chromium.googlesource.com/chromium/src/+/f848cbce89b422/chrome/browser/browser_features.cc) and [profile keepalive documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/profiles/keep_alive/README.md). This is a plausible mechanism for the observed process/profile distinction. The local records do not directly prove that a last-window close triggered this particular interval, or establish the runtime feature assignment in this Chrome build.

## Exclusions and missing evidence

Verified exclusions or constraints:

- The extension was not simply absent at the first failed call.
- The cached worker source was not an older version of `background.js` than the installed bundle at inspection.
- Chrome was not fully quit/restarted between the initial failure and recovery; the main/network/storage process start times preceded both.
- The bounded `pmset` interval 12:47–13:09 contained display-off/on notifications but no Sleep, Wake, or DarkWake entries. Display off alone does not establish system sleep.
- The 13:08 permission restart cannot explain the 13:07 failure by temporal order.
- The later unsupported `chrome://newtab` status occurred after a live connection and cannot explain the initial missing connection.

Still unavailable:

- Exact bridge-listener start time and first extension handshake time for the earlier gateway; its existing logs did not preserve these connection transitions with timestamps.
- Worker boot/suspend/crash events, exact alarm callback dispatch/completion times, attempted port order, connect/ready timeout phases, and WebSocket close/error codes for the affected interval.
- A direct historical count of Chrome windows and a definitive profile-destroy/last-window-close event.
- An App Nap or explicit process-suspend/resume event identifying Chrome as the cause. Bounded queries returned no such event. RunningBoard describing the main process as `running-active` does not prove a profile or worker was running.
- Real Windows reproduction and installed-package acceptance. The extension lifecycle is shared across platforms, and process-alive/profile-inactive states must also be considered for Windows and Edge; this Mac investigation alone does not prove Windows behavior.

The repair should provide bounded recovery for an explicitly requested browser and preserve metadata sufficient to distinguish listener startup, profile/worker wakeup, port/handshake failure, and successful connection. It should not require polling alarms to fire at an exact deadline, infer installation state from the socket, modify browser policies/profiles, or claim that a reproduced lifecycle defect reconstructs every detail of the original failure.
