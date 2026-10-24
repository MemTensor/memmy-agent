import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('rejects stale helpers after overwrite and during launch without starting an app', () => {
  const source = readFileSync(new URL('../App/native-computer-use/apps/OpenComputerUse/Sources/OpenComputerUse/MacOSAppAgentProxy.swift', import.meta.url), 'utf8');
  const versionSource = readFileSync(new URL('../App/native-computer-use/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/OpenComputerUseVersion.swift', import.meta.url), 'utf8');
  // Compile the production identity method, server reply, and launch loop with inert transport stubs.
  const between = (start, end) => {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(startAt);
    return source.slice(startAt, endAt);
  };
  const identity = between('    func isCurrentAgent(for appURL: URL)', '    func streamHistory()');
  const launch = between('    @MainActor\n    private static func connectOrLaunchAgent(', '    private static func proxyMCP(').replace('private static func', 'static func');
  const reply = between('            case "agentInfo":', '            case "terminate":').replace('            case "agentInfo":', '');
  const revision = source.match(/^private let appAgentProtocolRevision = \d+$/m)?.[0];
  const version = versionSource.match(/^public let openComputerUseVersion = ".+"$/m)?.[0];
  expect(revision).toBeTruthy();
  expect(version).toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), 'memmy-agent-identity-'));
  try {
    const fixture = join(root, 'main.swift');
    const binary = join(root, 'identity-fixture');
    writeFileSync(fixture, `
import Foundation
${revision}
${version}
private let appAgentProcessStartDate = Date()
private let appAgentCommand = "fixture-agent"
struct OpenComputerUseCLIError: Error { let message: String }
enum PermissionSupport { static var appURL: URL!; static func currentAppBundleURL() -> URL? { appURL } }
@discardableResult func unlink(_ path: String) -> Int32 { 0 }
final class NSWorkspace {
    static let shared = NSWorkspace()
    final class OpenConfiguration {
        var arguments: [String] = []; var activates = false; var createsNewApplicationInstance = false
    }
    func openApplication(at: URL, configuration: OpenConfiguration, completionHandler: (Int?, Error?) -> Void) {
        // No LaunchServices or executable is ever invoked.
    }
}
final class AppAgentSocketClient {
    static var pending: [AppAgentSocketClient?] = []
    static var terminated = 0
    let info: [String: Any]
    let executable: URL?
    init(_ info: [String: Any], executable: URL?) { self.info = info; self.executable = executable }
    static func connect(path: String) -> AppAgentSocketClient? { pending.isEmpty ? nil : pending.removeFirst() }
    func request(_ request: [String: Any]) throws -> [String: Any] {
        if request["kind"] as? String == "terminate" { Self.terminated += 1 }
        return info
    }
    func executableURL(for appURL: URL) -> URL? { executable }
${identity}
}
enum Proxy {
${launch}
}
func serverInfo() -> [String: Any] {
${reply}
}
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let app = root.appendingPathComponent("Memmy Computer Use.app")
let executable = app.appendingPathComponent("Contents/MacOS/MemmyComputerUse")
try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
try Data("inert fixture".utf8).write(to: executable)
let now = Date().timeIntervalSince1970
try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: now - 600)], ofItemAtPath: executable.path)
PermissionSupport.appURL = app
let legacy: [String: Any] = ["bundleURL": app.path, "processStartTime": now - 300]
var current = legacy
current["protocolRevision"] = appAgentProtocolRevision
current["version"] = openComputerUseVersion
func accepts(_ info: [String: Any], executable: URL? = executable) throws -> Bool {
    try AppAgentSocketClient(info, executable: executable).isCurrentAgent(for: app)
}
var results: [String: Bool] = [:]
results["legacyAfterOlderBuild"] = try accepts(legacy)
results["current"] = try accepts(current)
var changed = current; changed["version"] = "obsolete-build"
results["wrongVersion"] = try accepts(changed)
changed = current; changed["protocolRevision"] = appAgentProtocolRevision - 1
results["wrongRevision"] = try accepts(changed)
changed = current; changed.removeValue(forKey: "version")
results["missingVersion"] = try accepts(changed)
changed = current; changed.removeValue(forKey: "protocolRevision")
results["missingRevision"] = try accepts(changed)
changed = current; changed["bundleURL"] = root.appendingPathComponent("Other.app").path
results["differentBundle"] = try accepts(changed)
changed = current; changed["processStartTime"] = now - 900
results["processBeforeBinary"] = try accepts(changed)
results["legacyWithoutExecutable"] = try accepts(legacy, executable: nil)
results["currentWithoutExecutable"] = try accepts(current, executable: nil)
let server = serverInfo()
results["serverUsesCompiledIdentity"] = server["protocolRevision"] as? Int == appAgentProtocolRevision && server["version"] as? String == openComputerUseVersion
let oldClient = AppAgentSocketClient(legacy, executable: executable)
let currentClient = AppAgentSocketClient(current, executable: executable)
try MainActor.assumeIsolated {
    AppAgentSocketClient.pending = [nil, oldClient, currentClient]
    results["launchReturnsCurrent"] = try Proxy.connectOrLaunchAgent(socketPath: "inert-fixture") === currentClient
    AppAgentSocketClient.pending = [oldClient, currentClient]
    results["existingLegacyReplaced"] = try Proxy.connectOrLaunchAgent(socketPath: "inert-fixture") === currentClient && AppAgentSocketClient.terminated == 1
}
let encoded = try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
print(String(decoding: encoded, as: UTF8.self))
`);
    const compiled = spawnSync('swiftc', [fixture, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const result = spawnSync(binary, [root], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      legacyAfterOlderBuild: false,
      current: true,
      wrongVersion: false,
      wrongRevision: false,
      missingVersion: false,
      missingRevision: false,
      differentBundle: false,
      processBeforeBinary: false,
      legacyWithoutExecutable: false,
      currentWithoutExecutable: true,
      serverUsesCompiledIdentity: true,
      launchReturnsCurrent: true,
      existingLegacyReplaced: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
