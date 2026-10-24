import Foundation

@main struct CleanupPolicySmoke {
    static func main() throws {
        let stock: [String: Any] = ["class": "rule", "rule": "use-login-window-ui", "version": 1]
        let installed: [String: Any] = [
            "class": "rule", "rule": [remoteRightName, "use-login-window-ui"],
            "k-of-n": 1, "version": 1,
        ]
        let restored = try restoredScreenRule(installed, backup: stock)
        precondition(NSDictionary(dictionary: restored).isEqual(to: stock), "Restore the original String rule and implicit fallback")
        let restoredWithoutBackup = try restoredScreenRule(installed, backup: nil)
        precondition(restoredWithoutBackup["rule"] as? [String] == ["use-login-window-ui"])
        precondition(restoredWithoutBackup["k-of-n"] as? Int == 1)

        var changed = installed
        changed["rule"] = ["example.new.remote", remoteRightName, "use-login-window-ui", "example.other.remote"]
        changed["timeout"] = 300
        let removed = try restoredScreenRule(changed, backup: stock)
        precondition(removed["rule"] as? [String] == ["example.new.remote", "use-login-window-ui", "example.other.remote"])
        precondition(removed["timeout"] as? Int == 300, "Keep unrelated attributes and subsequent policy edits")
        let removedAgain = try restoredScreenRule(removed, backup: stock)
        precondition(NSDictionary(dictionary: removedAgain).isEqual(to: removed), "Cleanup must be idempotent")

        for unsafe: [String: Any] in [
            ["class": "rule", "rule": [remoteRightName], "k-of-n": 1],
            ["class": "rule", "rule": [remoteRightName, "use-login-window-ui"], "k-of-n": 2],
            ["class": "rule", "rule": [remoteRightName, "use-login-window-ui"]],
            ["class": "allow", "rule": [remoteRightName, "use-login-window-ui"], "k-of-n": 1],
        ] {
            do {
                _ = try restoredScreenRule(unsafe, backup: stock)
                preconditionFailure("Refuse any screen rule without a verified password fallback")
            } catch is PolicyError {}
        }

        var remote: [String: Any] = [
            "class": "evaluate-mechanisms", "identifier": "com.apple.security",
            "mechanisms": ["MemmyLockScreenAuthorizationPlugin:allow"],
            "requirement": "identifier \"com.apple.security\" and anchor apple",
            "shared": true, "tries": 1, "version": 1,
            "created": 123, "modified": 456, "comment": "Legacy Memmy rule",
        ]
        precondition(isMemmyRemoteRight(remote))
        remote["mechanisms"] = ["MemmyLockScreenAuthorizationPlugin:allow", "example:allow"]
        precondition(!isMemmyRemoteRight(remote), "Never delete another mechanism under the old right name")
        remote["mechanisms"] = ["MemmyLockScreenAuthorizationPlugin:allow"]
        remote["shared"] = false
        precondition(!isMemmyRemoteRight(remote), "Ownership requires the original trust and attempt constraints")
        print("legacy cleanup preserves password fallback and unrelated policy entries")
    }
}
