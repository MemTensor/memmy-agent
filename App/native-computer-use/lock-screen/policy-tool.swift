import Foundation

let remoteRightName = "cn.memtensor.memmy.computeruse.authorization-plugin.remote"
private let mechanismName = "MemmyLockScreenAuthorizationPlugin:allow"

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

func proposedScreenRule(_ original: [String: Any], install: Bool) throws -> [String: Any] {
    guard original["class"] as? String == "rule",
          original["k-of-n"] as? Int == 1,
          let rules = original["rule"] as? [String],
          rules.contains("use-login-window-ui") else {
        throw PolicyError.invalid("Screen unlock rule has no verified password-login fallback; refusing to change it")
    }
    var next = original
    if install {
        let withoutMemmy = rules.filter { $0 != remoteRightName }
        guard let fallback = withoutMemmy.firstIndex(of: "use-login-window-ui") else {
            throw PolicyError.invalid("Password-login fallback is missing")
        }
        var updated = withoutMemmy
        updated.insert(remoteRightName, at: fallback)
        next["rule"] = updated
    } else {
        next["rule"] = rules.filter { $0 != remoteRightName }
    }
    return next
}

func remoteAuthorizationRight() -> [String: Any] {
    [
        "class": "evaluate-mechanisms",
        "comment": "Memmy signed broker permits one interactive Computer Use screen unlock; denial preserves password login.",
        "identifier": "com.apple.security",
        "mechanisms": [mechanismName],
        "requirement": "identifier \"com.apple.security\" and anchor apple",
        "shared": true,
        "tries": 1,
        "version": 1,
    ]
}

func restoredScreenRule(_ current: [String: Any], backup: [String: Any]?) throws -> [String: Any] {
    let withoutMemmy = try proposedScreenRule(current, install: false)
    guard let backup else { return withoutMemmy }
    var currentComparable = withoutMemmy
    var backupComparable = backup
    for key in ["created", "modified"] {
        currentComparable.removeValue(forKey: key)
        backupComparable.removeValue(forKey: key)
    }
    // Restore the exact original rule when nobody changed its semantics after
    // installation. Otherwise remove only Memmy's branch and keep new entries.
    return NSDictionary(dictionary: currentComparable).isEqual(to: backupComparable)
        ? backup : withoutMemmy
}

#if !SYSTEM_INSTALLER
@main struct PolicyTool {
    static func main() {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard args.count >= 3 else {
                throw PolicyError.invalid("Usage: policy-tool install|uninstall SCREEN_INPUT SCREEN_OUTPUT [REMOTE_OUTPUT|BACKUP]")
            }
            let original = try readPlist(args[1])
            switch args[0] {
            case "install":
                guard args.count == 4 else { throw PolicyError.invalid("install requires REMOTE_OUTPUT") }
                try writePlist(proposedScreenRule(original, install: true), to: args[2])
                try writePlist(remoteAuthorizationRight(), to: args[3])
            case "uninstall":
                guard args.count == 3 || args.count == 4 else {
                    throw PolicyError.invalid("uninstall accepts an optional original-rule backup")
                }
                let backup = args.count == 4 ? try readPlist(args[3]) : nil
                try writePlist(restoredScreenRule(original, backup: backup), to: args[2])
            default:
                throw PolicyError.invalid("Unknown action")
            }
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
#endif
