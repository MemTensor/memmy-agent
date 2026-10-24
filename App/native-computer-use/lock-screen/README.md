# Legacy lock-screen component cleanup

The lock-screen operation feature has been removed. New native helpers have no
unlock broker, lease, guardian, wake/relock code, or authorization installer.
New builds remove its known resources from a reused helper bundle. This directory
contains only developer recovery tools for an installation made by an older
release; none of them is packaged or called by Memmy.

An older installation may still contain:

- `/Library/Security/SecurityAgentPlugins/MemmyLockScreenAuthorizationPlugin.bundle`
- the `cn.memtensor.memmy.computeruse.authorization-plugin.remote` authorization right
- that right's branch in `system.login.screensaver`
- `/Library/Application Support/MemmyLockScreenAuthorizationPlugin/screen-before.plist`

The old plugin requires a live signed broker and an approved, unconsumed lease.
Without that broker it denies its own branch, leaving the existing password-login
fallback. Its previous connection/read timeouts were up to 700 ms each; an
installed legacy branch can therefore still delay the fallback. Updating the
source does not remove a component already installed in macOS, and an old Memmy
process must be exited before relying on the new helper's behavior.

System cleanup requires explicit administrator authorization. Never delete the
plugin before removing and verifying its branch in the current screen rule.
Do not restore a whole historical authorization database or overwrite another
product's changes. The cleanup tool removes only Memmy's branch; when subsequent
policy edits have changed the rule, their entries and attributes survive. The
original rule's String/array shape is restored only when its semantics still
match the saved backup. Unknown ownership, signatures, permissions, or password
fallbacks cause cleanup to stop and leave the remaining components available.

For developer recovery, compile `policy-tool.swift` with `swiftc -parse-as-library`
and sign that cleanup-only executable with Memmy's Developer ID. After quitting
old Memmy processes, the user can explicitly run:

```bash
bash App/native-computer-use/lock-screen/uninstall-legacy-plugin.sh status
sudo bash App/native-computer-use/lock-screen/uninstall-legacy-plugin.sh uninstall /absolute/path/to/signed/cleanup-policy-tool
```

The script verifies the signed tool and installed plugin, verifies ownership of
the existing remote right, validates the current password-login fallback,
removes the screen branch first, verifies it is gone, and then removes the old
right and plugin. It retains the original backup for recovery and audit. The
cleanup-only tool has no install command and does not unlock or relock the Mac.
Immediately before a write or removal it rereads the relevant right and rejects
any change from the snapshot used for planning. The system command has no
compare-and-swap transaction, so a concurrent privileged policy change between
that final check and the mutation remains a manual-cleanup boundary.

`bash App/native-computer-use/lock-screen/tests/test-offline.sh` tests policy
transformations using temporary files and rejects install commands. It never
reads or writes the real authorization database, launches a helper, or sends
input. Native `LockScreenStateTests` separately cover refusal of locked or
unverifiable desktop sessions. Installed upgrade, legacy cleanup and real
macOS/Windows GUI acceptance remain user-owned checks.
