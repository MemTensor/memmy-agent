# Locked Mac isolated-device acceptance

Run this only on a disposable macOS test account or test Mac with a known local
administrator password and an independent recovery path. Do not use the active
workstation. Offline compilation and policy simulation are insufficient for
SecurityAgent, TCC, wake, and crash recovery.

## Setup and evidence

1. Record macOS version, CPU, Memmy build hash, helper/plug-in/guardian
   `codesign -dv` identifiers and Team IDs, and the original read-only
   `security authorizationdb read system.login.screensaver` plist. Keep the
   original rule outside the test account. Confirm normal password unlock
   before changing the rule.
2. Use a Developer ID signed, notarized test build. Start Desktop and its
   managed Agent with `MEMMY_LOCKED_MAC_USE_ENABLED=1`. In Computer Use
   settings, explicitly install the authorization component and separately
   grant locked-use consent. Approve only a harmless test app, such as
   Calculator. Confirm the helper and independently signed `lock-guardian`
   processes are running. Record the guardian PID and the helper PID.
3. Record the modified screen rule and verify `use-login-window-ui` remains
   after Memmy's remote right. Confirm the local password still unlocks while
   the helper is stopped; this checks the fallback before automated trials.

## Trials

For each trial, start from a freshly locked console and a fresh user message.
Use an observer camera or remote test-console recording to capture the lock
screen and timing; do not record passwords.

| Trial | Action | Required observation |
| --- | --- | --- |
| Normal action | Ask Memmy to read Calculator state while locked. | One unlock for the interactive message; action completes; Mac relocks and a password is required again. |
| Non-interactive denial | Trigger a scheduled or internal continuation while locked. | No lease, wake, or app action. Password fallback remains usable. |
| Before-consume crash | Stop the helper after guardian `ARM` and before SecurityAgent `CONSUME`. | Guardian does not lock a later manual user unlock. |
| After-consume crash | Stop the helper immediately after automatic unlock, before normal `release`. Use the recorded helper PID only. | Guardian survives helper exit and requests relock within its 20-second recovery window; screen is confirmed locked. |
| User takeover | Move the physical mouse or type during an auto-unlocked action; repeat with Touch ID or another supported manual-unlock method. | Agent pauses; guardian does not lock over the user; a new explicit message is needed before further action. |
| Guardian loss | Stop guardian before a locked request, then during an auto-unlocked action. | Before request: no action is sent. During action: helper requests relock and reports uncertainty; no unattended unlocked session remains. |
| Contention | Send two interactive turns concurrently from separate chats. | At most one lease is consumed; the other request is denied without an app action. |
| Failure and removal | Interrupt install once, then complete it and remove it from settings. | Password fallback survives interruption; uninstall removes only Memmy's right and restores the original rule when no third party changed it. |

For crash trials use `kill -9 <recorded-helper-pid>` only after visually
confirming the PID and stage on the isolated Mac. Do not use `killall`, which
could terminate the guardian or other app instances. Save broker/guardian
logs, time-stamped screen video, policy before/after, and observed process
exit/relock times. The release gate stays closed if any trial is uncertain or
fails, especially if the guardian input tap lacks permission or physical input
is misclassified.
