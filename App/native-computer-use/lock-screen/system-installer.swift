import Darwin
import Foundation
import Security

private let screenRight = "system.login.screensaver"
private let pluginPath = "/Library/Security/SecurityAgentPlugins/MemmyLockScreenAuthorizationPlugin.bundle"
private let stateDirectory = "/Library/Application Support/MemmyLockScreenAuthorizationPlugin"
private let backupPath = stateDirectory + "/screen-before.plist"
private let installerRequirement = "identifier \"cn.memtensor.memmy.computeruse.lock-installer\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""
private let pluginRequirement = "identifier \"cn.memtensor.memmy.computeruse.authorization-plugin\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""

private enum InstallError: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        if case .invalid(let reason) = self { return reason }
        return nil
    }
}

private func signedSelf() -> Bool {
    var code: SecCode?
    guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(installerRequirement as CFString, SecCSFlags(), &requirement) == errSecSuccess,
          let requirement else { return false }
    return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
}

private func signedPlugin(_ path: String) -> Bool {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, SecCSFlags(), &code) == errSecSuccess,
          let code else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(pluginRequirement as CFString, SecCSFlags(), &requirement) == errSecSuccess,
          let requirement else { return false }
    return SecStaticCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
}

@discardableResult
private func systemTool(_ executable: String, _ arguments: [String], input: Data? = nil,
                        allowFailure: Bool = false) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    let stdin = Pipe()
    process.standardInput = stdin
    try process.run()
    if let input { stdin.fileHandleForWriting.write(input) }
    try? stdin.fileHandleForWriting.close()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    if process.terminationStatus != 0 && !allowFailure {
        throw InstallError.invalid("System authorization command failed: \(executable) \(arguments.first ?? "")")
    }
    return data
}

private func right(_ name: String) throws -> [String: Any] {
    let data = try systemTool("/usr/bin/security", ["authorizationdb", "read", name])
    guard let value = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        throw InstallError.invalid("System authorization rule is malformed")
    }
    return value
}

private func writeRight(_ name: String, _ value: [String: Any]) throws {
    let data = try PropertyListSerialization.data(fromPropertyList: value, format: .xml, options: 0)
    try systemTool("/usr/bin/security", ["authorizationdb", "write", name], input: data)
}

private func removeRight(_ name: String) {
    _ = try? systemTool("/usr/bin/security", ["authorizationdb", "remove", name], allowFailure: true)
}

private func containsMemmyRight(_ rule: [String: Any]) -> Bool {
    (rule["rule"] as? [String])?.contains(remoteRightName) == true
}

private func requireRootOwnedDirectory(_ path: String) throws {
    var info = stat()
    guard lstat(path, &info) == 0, info.st_uid == 0,
          info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
          info.st_mode & 0o022 == 0 else {
        throw InstallError.invalid("Unsafe system authorization directory: \(path)")
    }
}

private func installed() -> Bool {
    guard signedPlugin(pluginPath),
          let remote = try? right(remoteRightName),
          (remote["mechanisms"] as? [String]) == ["MemmyLockScreenAuthorizationPlugin:allow"],
          let screen = try? right(screenRight), containsMemmyRight(screen) else { return false }
    return true
}

private func install(source: String) throws {
    guard geteuid() == 0 else { throw InstallError.invalid("Administrator authorization is required") }
    guard !FileManager.default.fileExists(atPath: pluginPath), (try? right(remoteRightName)) == nil else {
        throw InstallError.invalid("Existing Memmy authorization must be removed first")
    }
    guard signedPlugin(source) else { throw InstallError.invalid("Packaged authorization plugin signature is invalid") }
    let original = try right(screenRight)
    let next = try proposedScreenRule(original, install: true)
    let remote = remoteAuthorizationRight()
    let fm = FileManager.default
    try requireRootOwnedDirectory("/Library/Security/SecurityAgentPlugins")
    try fm.createDirectory(atPath: stateDirectory, withIntermediateDirectories: true,
                           attributes: [.posixPermissions: 0o700])
    try requireRootOwnedDirectory(stateDirectory)
    let backup = try PropertyListSerialization.data(fromPropertyList: original, format: .xml, options: 0)
    try backup.write(to: URL(fileURLWithPath: backupPath), options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o600, .ownerAccountID: 0], ofItemAtPath: backupPath)
    let temporary = "/Library/Security/SecurityAgentPlugins/.MemmyLockScreenAuthorizationPlugin.\(UUID().uuidString).bundle"
    try fm.copyItem(atPath: source, toPath: temporary)
    defer { try? fm.removeItem(atPath: temporary) }
    try systemTool("/usr/sbin/chown", ["-R", "root:wheel", temporary])
    try systemTool("/bin/chmod", ["-R", "go-w", temporary])
    guard signedPlugin(temporary) else { throw InstallError.invalid("Copied authorization plugin signature is invalid") }
    try fm.moveItem(atPath: temporary, toPath: pluginPath)
    do {
        try writeRight(remoteRightName, remote)
        try writeRight(screenRight, next)
        guard installed() else { throw InstallError.invalid("Authorization install verification failed") }
    } catch {
        try? writeRight(screenRight, original)
        removeRight(remoteRightName)
        try? fm.removeItem(atPath: pluginPath)
        throw error
    }
}

private func uninstall() throws {
    guard geteuid() == 0 else { throw InstallError.invalid("Administrator authorization is required") }
    let current = try right(screenRight)
    let backup: [String: Any]?
    if let attrs = try? FileManager.default.attributesOfItem(atPath: backupPath),
       (attrs[.ownerAccountID] as? NSNumber)?.intValue == 0,
       ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o022 == 0,
       let data = try? Data(contentsOf: URL(fileURLWithPath: backupPath)) {
        backup = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    } else { backup = nil }
    let next = try restoredScreenRule(current, backup: backup)
    try writeRight(screenRight, next)
    guard !containsMemmyRight(try right(screenRight)) else {
        throw InstallError.invalid("Memmy authorization remains in the screen rule")
    }
    if let remote = try? right(remoteRightName),
       (remote["mechanisms"] as? [String]) == ["MemmyLockScreenAuthorizationPlugin:allow"] {
        removeRight(remoteRightName)
    }
    if FileManager.default.fileExists(atPath: pluginPath) {
        try FileManager.default.removeItem(atPath: pluginPath)
    }
}

@main struct SystemInstaller {
    static func main() {
        do {
            guard signedSelf() else { throw InstallError.invalid("Signed Memmy installer is required") }
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard arguments.count == 1, let action = arguments.first,
                  ["status", "install", "uninstall"].contains(action) else {
                throw InstallError.invalid("Usage: lock-installer status|install|uninstall")
            }
            switch action {
            case "status": print(installed() ? "installed" : "not-installed")
            case "install":
                let ownPath = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
                guard ownPath.lastPathComponent == "lock-installer" else {
                    throw InstallError.invalid("Unexpected installer executable path")
                }
                let source = ownPath.deletingLastPathComponent()
                    .appendingPathComponent("MemmyLockScreenAuthorizationPlugin.bundle").path
                try install(source: source)
                print("installed")
            case "uninstall":
                try uninstall()
                print("not-installed")
            default: break
            }
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
