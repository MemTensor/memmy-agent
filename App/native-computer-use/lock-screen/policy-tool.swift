import Foundation

// Offline legacy cleanup only. This tool cannot create an authorization right.
let remoteRightName = "cn.memtensor.memmy.computeruse.authorization-plugin.remote"

enum PolicyError: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        if case .invalid(let message) = self { return message }
        return nil
    }
}

func readPlist(_ path: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let result = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        throw PolicyError.invalid("Authorization rule is not a plist dictionary")
    }
    return result
}

func writePlist(_ rule: [String: Any], to path: String) throws {
    let data = try PropertyListSerialization.data(fromPropertyList: rule, format: .xml, options: 0)
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func isMemmyRemoteRight(_ value: [String: Any]) -> Bool {
    let expected: [String: Any] = [
        "class": "evaluate-mechanisms", "identifier": "com.apple.security",
        "mechanisms": ["MemmyLockScreenAuthorizationPlugin:allow"],
        "requirement": "identifier \"com.apple.security\" and anchor apple",
        "shared": true, "tries": 1, "version": 1,
    ]
    var actual = value
    for key in ["created", "modified", "comment"] { actual.removeValue(forKey: key) }
    return NSDictionary(dictionary: actual).isEqual(to: expected)
}

func restoredScreenRule(_ current: [String: Any], backup: [String: Any]?) throws -> [String: Any] {
    let rules: [String]?
    if let single = current["rule"] as? String { rules = [single] }
    else { rules = current["rule"] as? [String] }
    let defaultSingleFallback = current["k-of-n"] == nil && rules == ["use-login-window-ui"]
    guard current["class"] as? String == "rule",
          current["k-of-n"] as? Int == 1 || defaultSingleFallback,
          let rules, rules.contains("use-login-window-ui") else {
        throw PolicyError.invalid("Screen unlock rule has no verified password-login fallback; refusing to change it")
    }
    // An already-clean rule needs no restoration from a historical backup.
    guard rules.contains(remoteRightName) else { return current }
    var withoutMemmy = current
    withoutMemmy["rule"] = rules.filter { $0 != remoteRightName }
    guard let backup else { return withoutMemmy }
    func comparableShape(_ rule: [String: Any]) -> [String: Any] {
        var value = rule
        if let single = value["rule"] as? String { value["rule"] = [single] }
        if value["k-of-n"] == nil, value["rule"] as? [String] == ["use-login-window-ui"] {
            value["k-of-n"] = 1
        }
        for key in ["created", "modified"] { value.removeValue(forKey: key) }
        return value
    }
    // Restore the exact original shape only if subsequent policy edits have
    // not changed its semantics. Other products' entries always survive.
    return NSDictionary(dictionary: comparableShape(withoutMemmy)).isEqual(to: comparableShape(backup))
        ? backup : withoutMemmy
}

#if !LEGACY_POLICY_TEST
@main struct PolicyTool {
    static func main() {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args.count == 2 && args[0] == "verify-remote" {
                guard isMemmyRemoteRight(try readPlist(args[1])) else {
                    throw PolicyError.invalid("Existing authorization rule is not a verified Memmy rule; refusing to remove it")
                }
            } else if args.count == 3 && args[0] == "verify-snapshot" {
                guard NSDictionary(dictionary: try readPlist(args[1])).isEqual(to: try readPlist(args[2])) else {
                    throw PolicyError.invalid("System authorization changed during cleanup; refusing to overwrite it")
                }
            } else if (args.count == 3 || args.count == 4) && args[0] == "uninstall" {
                let backup = args.count == 4 ? try readPlist(args[3]) : nil
                let original = try readPlist(args[1])
                let restored = try restoredScreenRule(original, backup: backup)
                try writePlist(restored, to: args[2])
                print(NSDictionary(dictionary: original).isEqual(to: restored) ? "unchanged" : "removed")
            } else {
                throw PolicyError.invalid("Usage: policy-tool uninstall SCREEN_INPUT SCREEN_OUTPUT [BACKUP] | verify-remote REMOTE_INPUT | verify-snapshot EXPECTED ACTUAL")
            }
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
#endif
