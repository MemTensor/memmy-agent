# macOS lock-screen authorization component

This directory contains an **uninstalled, disabled** SecurityAgent plugin and
its offline policy tooling. The standard Computer Use helper denies desktop
operations while macOS is locked. Building or packaging these files never
changes `system.login.screensaver`.

In a release package the embedded helper is signed with Memmy's main bundle
identifier `cn.memtensor.memmy`, so its Accessibility, Input Monitoring, and
Screen Recording grants are shared with `Memmy.app`. The installer, guardian,
and authorization plug-in retain separate child identifiers for their own
launch and signature checks.

## Components

- `MemmyLockScreenAuthorizationPlugin.c` implements the `allow` mechanism.
  It has no password API or credential storage. It connects to a local socket,
  verifies the **peer process** is the Developer ID signed Memmy Computer Use
  helper (Team `S7NLXHGBJ2`), and returns allow only for one broker reply.
  Connection, signature, protocol, or timeout failures return deny.
- `LockScreenAuthorizationBroker.swift` is the helper-side socket server. It
  starts only in the Developer ID signed helper app process and verifies the
  signed Memmy main-process peer before accepting its `H1` control protocol.
  `LockScreenLease.swift` keeps one approved interactive turn lease for at most
  15 seconds; the first authorization check consumes it. A read-only event tap
  pauses leases on external input, and failure to install or keep the tap active
  denies lease creation. The signed macOS package can start this broker after the user enables the lock-screen switch and grants the per-turn consent.
- `lock-guardian` is an independently signed companion process launched only
  by the broker after the user enables the lock-screen switch. It verifies the signed helper parent and runs
  its own input tap. Before the SecurityAgent plug-in can receive an allow
  reply, the guardian must acknowledge `ARM` and then `CONSUME` for the same
  lease. It watches the helper's private stdin pipe for EOF; if the helper dies
  after consumption, it observes the console for up to 20 seconds and retries
  the public lock shortcut up to five times, unless physical input indicates
  user takeover. An unconsumed or disarmed lease cannot trigger recovery.
- `policy-tool.swift` constructs two policy values without writing the system
  database. The packaged `lock-installer` is a compiled, signed administrator
  utility. It verifies its own Developer ID signature in its running process,
  verifies the plug-in signature, backs up the existing screen rule, creates
  Memmy's separate remote right, inserts that right before the existing
  `use-login-window-ui` fallback, and verifies the result. Uninstall removes
  Memmy's branch and restores the exact backup if the rest of the policy is
  unchanged. It preserves other applications' rules if they changed later.
  The source-only `install-plugin.sh` remains for review and offline policy
  comparisons; the app does not package or execute it with administrator rights.

## Offline verification

`bash tests/test-offline.sh` compiles the plugin, proves denial when no signed
broker exists, simulates policy install/remove without writing authorizationdb,
and checks lease one-use, expiration and physical-input pause. The regular
Mac helper build signs these resources inside `Memmy Computer Use.app`.

The packaged Memmy settings page can install or remove the signed component
after an explicit host confirmation and macOS administrator authorization. It
labels an installed component separately from an operational lock-screen
session. A separate, revocable settings consent is required for locked use;
installation and target-app approval do not grant it. The managed Agent derives
the message identity from a live user turn (not model tool arguments), and the
host accepts only its current managed child generation. Internal continuations
and turns without an inbound message ID are denied. The managed Agent can
request a per-action, per-interactive-turn lease
from the host; the signed broker posts a wake key, waits for the SecurityAgent
plugin to consume the lease, checks that the session unlocked, then posts the
macOS lock shortcut and verifies relock when the native action ends. The
broker retries that shortcut up to five times while the auto-unlocked session
remains active and no physical input is detected. An observed relock, including
one initiated by macOS or the user before release, retires the old lease. A
normal helper shutdown also attempts to lock an auto-unlocked session. The
settings switch installs the authorization component when needed, then stores
a separate revocable consent. The managed MCP launcher forwards the
managed-host gate to the native CLI; the Desktop host remains the final
availability and consent check. macOS still rejects an unsigned installer,
authorization plug-in, helper, or guardian; that is an operating-system trust
requirement, not a Memmy package-mode switch.

## Integration and live acceptance

The implementation is wired through the settings consent flow, but device-level
acceptance still needs to be recorded. The installed Codex package
uses a separate `CUALockScreenGuardian.app`; Memmy now has its own narrower
companion, but neither its input tap nor crash relock has been exercised on a
locked Mac. This is a release blocker. In particular, the
SecurityAgent fallback on deny, whether a synthetic wake key triggers the
system's real loginwindow authorization path, event-tap behavior while locked,
and whether Control-Command-Q reliably relocks this macOS version need an
isolated test Mac. If any of those checks fails, the public gate stays closed.
The event tap cannot be assumed to distinguish every synthetic event from
physical input. Installation and rollback also need isolated acceptance with
normal password fallback, user takeover, concurrent turns, and crashed helper.
No part of this source has been installed on the current Mac.
The exact device-level trial matrix is in `tests/ISOLATED-MAC-ACCEPTANCE.md`.
