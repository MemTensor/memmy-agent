import AppKit
import Darwin
import Foundation
import MemmyComputerHistoryKit
import MemmyComputerUseKit

private let appAgentCommand = "__memmy-computer-use-app-agent"
private let appAgentDisableEnvironmentKey = "OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY"
private let appAgentProcessStartDate = Date()

enum MacOSAppAgentProxy {
    static func isAgentInvocation(arguments: [String]) -> Bool {
        arguments.first == appAgentCommand
    }

    @MainActor
    static func runAgent(arguments: [String]) throws {
        guard arguments.count == 2 else {
            throw OpenComputerUseCLIError(message: "\(appAgentCommand) requires a socket path")
        }

        try MacOSAppAgentRuntime.run(socketPath: arguments[1])
    }

    static func shouldProxy(command: OpenComputerUseCLICommand) -> Bool {
        shouldUseMacOSAppAgentProxy(
            command: command,
            proxyDisabled: proxyDisabled,
            appBundleAvailable: PermissionSupport.currentAppBundleURL() != nil,
            runningFromLaunchServicesAppInstance: isRunningFromLaunchServicesAppInstance
        )
    }

    @MainActor
    static func runProxy(command: OpenComputerUseCLICommand, arguments: [String]) throws -> Int32 {
        let socketPath = defaultSocketPath()
        let client = try connectOrLaunchAgent(socketPath: socketPath)

        switch command {
        case .mcp:
            try proxyMCP(client: client)
            return EXIT_SUCCESS
        default:
            let response = try sendCLIRequest(arguments: arguments, client: client)
            if !response.stdout.isEmpty {
                FileHandle.standardOutput.write(Data(response.stdout.utf8))
            }
            if !response.stderr.isEmpty {
                FileHandle.standardError.write(Data(response.stderr.utf8))
            }
            return response.exitCode
        }
    }

    @MainActor
    static func runHistoryProxy(arguments: [String]) throws -> Int32 {
        if arguments == ["--stop-agent"] {
            if let client = AppAgentSocketClient.connect(path: defaultSocketPath()) {
                _ = try client.request(["kind": "terminate"])
            }
            return EXIT_SUCCESS
        }
        let client = try connectOrLaunchAgent(socketPath: defaultSocketPath())
        if arguments.contains("--permissions") {
            let response = try client.request([
                "kind": "historyPermissions",
                "requestInputMonitoring": arguments.contains("--request-input-monitoring"),
                "requestAccessibility": arguments.contains("--request-accessibility"),
            ])
            let data = try JSONSerialization.data(withJSONObject: response)
            FileHandle.standardOutput.write(data + Data([10]))
            return EXIT_SUCCESS
        }
        guard arguments.isEmpty else {
            throw OpenComputerUseCLIError(message: "Unknown Memmy Computer History argument")
        }
        try client.streamHistory()
        return EXIT_SUCCESS
    }

    private static var proxyDisabled: Bool {
        let value = ProcessInfo.processInfo.environment[appAgentDisableEnvironmentKey]?.lowercased()
        return value == "1" || value == "true" || value == "yes" || value == "on"
    }

    private static var isRunningFromOpenComputerUseAppBundle: Bool {
        Bundle.main.bundleURL.standardizedFileURL.pathExtension == "app"
            && PermissionSupport.isMemmyComputerUseBundleIdentifier(Bundle.main.bundleIdentifier)
    }

    private static var isRunningFromLaunchServicesAppInstance: Bool {
        isRunningFromOpenComputerUseAppBundle && getppid() == 1
    }

    private static func defaultSocketPath() -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(
                openComputerUseAppAgentSocketFileName(
                    namespace: ProcessInfo.processInfo.environment[openComputerUseAppAgentSocketNamespaceEnvironmentKey]
                )
            )
            .standardizedFileURL
            .path
    }

    @MainActor
    private static func connectOrLaunchAgent(socketPath: String) throws -> AppAgentSocketClient {
        guard let appURL = PermissionSupport.currentAppBundleURL() else {
            throw OpenComputerUseCLIError(message: "Unable to locate Memmy Computer Use.app for app-scoped macOS permissions.")
        }

        if let client = AppAgentSocketClient.connect(path: socketPath) {
            if (try? client.isCurrentAgent(for: appURL)) == true {
                return client
            }

            _ = try? client.request(["kind": "terminate"])
            unlink(socketPath)
        } else {
            unlink(socketPath)
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [appAgentCommand, socketPath]
        configuration.activates = false
        configuration.createsNewApplicationInstance = true

        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, _ in }

        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let client = AppAgentSocketClient.connect(path: socketPath) {
                return client
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        throw OpenComputerUseCLIError(message: "Timed out waiting for Memmy Computer Use.app agent to start.")
    }

    private static func proxyMCP(client: AppAgentSocketClient) throws {
        while let line = readLine(strippingNewline: true) {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }

            let response = try client.request([
                "kind": "mcp",
                "line": line,
                "environment": proxiedEnvironment(),
            ])

            if let responseLine = response["response"] as? String {
                FileHandle.standardOutput.write(Data((responseLine + "\n").utf8))
            }
        }
    }

    private static func sendCLIRequest(arguments: [String], client: AppAgentSocketClient) throws -> CLIProxyResponse {
        let response = try client.request([
            "kind": "cli",
            "arguments": arguments,
            "environment": proxiedEnvironment(),
        ])

        return CLIProxyResponse(
            stdout: response["stdout"] as? String ?? "",
            stderr: response["stderr"] as? String ?? "",
            exitCode: Int32(response["exitCode"] as? Int ?? 1)
        )
    }

    private static func proxiedEnvironment() -> [String: String] {
        ProcessInfo.processInfo.environment.filter { key, _ in
            key.hasPrefix("OPEN_COMPUTER_USE_") || key == "MEMMY_LOCKED_MAC_USE_ENABLED"
        }
    }
}

private struct CLIProxyResponse {
    let stdout: String
    let stderr: String
    let exitCode: Int32
}

@MainActor
private final class MacOSAppAgentRuntime: NSObject, NSApplicationDelegate {
    private let socketPath: String
    private var listener: AppAgentSocketListener?
    private var turnEndedObserver: NSObjectProtocol?

    private init(socketPath: String) {
        self.socketPath = socketPath
    }

    static func run(socketPath: String) throws {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)

        let delegate = MacOSAppAgentRuntime(socketPath: socketPath)
        application.delegate = delegate
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        turnEndedObserver = DistributedNotificationCenter.default().addObserver(
            forName: openComputerUseTurnEndedNotificationName,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                resetOpenComputerUseVisualCursor()
            }
        }

        do {
            let listener = try AppAgentSocketListener(path: socketPath)
            self.listener = listener
            listener.start()
            // LaunchServices does not inherit the MCP client's environment.
            // The lock-screen broker starts lazily on a managed MCP request.
        } catch {
            writeAgentError(error)
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let turnEndedObserver {
            DistributedNotificationCenter.default().removeObserver(turnEndedObserver)
        }
        listener?.stop()
        stopHistoryRecorder()
        LockScreenAuthorizationBroker.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func writeAgentError(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}

private final class AppAgentSocketListener: @unchecked Sendable {
    private let path: String
    private let socketFD: Int32
    private var running = true

    init(path: String) throws {
        self.path = path
        unlink(path)

        socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else {
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }
        suppressBrokenPipeSignal(socketFD)

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        try withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            try pointer.withMemoryRebound(to: CChar.self, capacity: pathCapacity) { buffer in
                let bytes = Array(path.utf8)
                guard bytes.count < pathCapacity else {
                    throw OpenComputerUseCLIError(message: "Socket path is too long: \(path)")
                }
                for index in 0..<bytes.count {
                    buffer[index] = CChar(bitPattern: bytes[index])
                }
                buffer[bytes.count] = 0
            }
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            close(socketFD)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }

        guard listen(socketFD, 16) == 0 else {
            close(socketFD)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }

        guard chmod(path, mode_t(S_IRUSR | S_IWUSR)) == 0 else {
            close(socketFD)
            unlink(path)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }
    }

    func start() {
        Thread.detachNewThread {
            self.acceptLoop()
        }
    }

    func stop() {
        running = false
        close(socketFD)
        unlink(path)
    }

    private func acceptLoop() {
        while running {
            let clientFD = accept(socketFD, nil, nil)
            guard clientFD >= 0 else {
                if running {
                    Thread.sleep(forTimeInterval: 0.05)
                }
                continue
            }
            suppressBrokenPipeSignal(clientFD)

            Thread.detachNewThread {
                AppAgentConnection(fileDescriptor: clientFD).run()
            }
        }
    }
}

private final class AppAgentConnection: @unchecked Sendable {
    private let fileDescriptor: Int32
    private let server = StdioMCPServer()

    init(fileDescriptor: Int32) {
        self.fileDescriptor = fileDescriptor
    }

    func run() {
        guard let file = fdopen(fileDescriptor, "r+") else {
            close(fileDescriptor)
            return
        }
        defer { fclose(file) }

        while let line = readAgentLine(file) {
            if let request = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
               request["kind"] as? String == "historyObserve" {
                runHistoryStream(file: file)
                return
            }
            let response = handle(requestLine: line)
            writeAgentLine(response, to: file)
        }
    }

    private func handle(requestLine: String) -> [String: Any] {
        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(requestLine.utf8)) as? [String: Any],
                  let kind = request["kind"] as? String
            else {
                return ["error": "Invalid app-agent request"]
            }

            switch kind {
            case "agentInfo":
                return [
                    "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
                    "bundleURL": Bundle.main.bundleURL.standardizedFileURL.path,
                    "executableURL": Bundle.main.executableURL?.standardizedFileURL.path ?? "",
                    "processStartTime": appAgentProcessStartDate.timeIntervalSince1970,
                ]
            case "terminate":
                Task { @MainActor in
                    NSApp.terminate(nil)
                }
                return ["ok": true]
            case "historyPermissions":
                return DispatchQueue.main.sync {
                    permissionsPayload(
                        request: false,
                        requestInputMonitoring: request["requestInputMonitoring"] as? Bool == true,
                        requestAccessibility: request["requestAccessibility"] as? Bool == true
                    )
                }
            case "mcp":
                let line = request["line"] as? String ?? ""
                let environment = request["environment"] as? [String: String] ?? [:]
                let response = AppAgentEnvironment.withOverrides(environment) {
                    if environment["MEMMY_LOCKED_MAC_USE_ENABLED"] == "1"
                        && LockScreenAuthorizationBroker.isSignedReleaseProcess() {
                        // A broker without a host-approved lease always denies.
                        // Failure must not break ordinary unlocked Computer Use.
                        do { try LockScreenAuthorizationBroker.shared.start() }
                        catch {
                            FileHandle.standardError.write(Data("Locked Mac broker unavailable\n".utf8))
                        }
                    }
                    return server.handle(line: line)
                }
                if let response {
                    return ["response": response]
                }
                return ["response": NSNull()]
            case "cli":
                let arguments = request["arguments"] as? [String] ?? []
                let environment = request["environment"] as? [String: String] ?? [:]
                let response = AppAgentEnvironment.withOverrides(environment) {
                    runCLI(arguments: arguments)
                }
                return [
                    "stdout": response.stdout,
                    "stderr": response.stderr,
                    "exitCode": Int(response.exitCode),
                ]
            default:
                return ["error": "Unknown app-agent request kind: \(kind)"]
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            return ["error": message]
        }
    }

    private func runHistoryStream(file: UnsafeMutablePointer<FILE>) {
        guard let output = fdopen(dup(fileno(file)), "w") else {
            writeAgentLine(["error": "Could not open the History event stream"], to: file)
            return
        }
        let writer = HistoryStreamWriter(output: output)
        defer { writer.close() }
        // A connection owns the recorder for its whole lifetime. When History
        // stops or its host dies, EOF tears down the event tap immediately.
        let startError: Error? = DispatchQueue.main.sync {
            do {
                try startHistoryRecorder(output: writer.event)
                return nil
            } catch { return error }
        }
        if let startError {
            writer.fail(startError.localizedDescription)
            return
        }
        writer.accept()
        while readAgentLine(file) != nil {}
        DispatchQueue.main.sync { stopHistoryRecorder() }
    }

    private func runCLI(arguments: [String]) -> CLIProxyResponse {
        do {
            let command = try parseOpenComputerUseCLI(arguments: arguments)

            switch command {
            case .launchOnboarding:
                // Only Memmy presents consent and permission guidance.
                return CLIProxyResponse(stdout: "", stderr: "", exitCode: EXIT_SUCCESS)

            case .doctor:
                let permissions = PermissionDiagnostics.current()
                return CLIProxyResponse(stdout: permissions.summary + "\n", stderr: "", exitCode: EXIT_SUCCESS)

            case let .captureScreen(displayId):
                return CLIProxyResponse(stdout: memmyDesktopCaptureJSON(displayId: displayId) + "\n", stderr: "", exitCode: EXIT_SUCCESS)

            case .settingsWindow:
                // Window geometry is queried by a separate read-only process.
                return CLIProxyResponse(stdout: "", stderr: "settings-window does not use the app agent\n", exitCode: EXIT_FAILURE)

            case .listApps:
                let service = ComputerUseService()
                return CLIProxyResponse(stdout: (service.listApps().primaryText ?? "") + "\n", stderr: "", exitCode: EXIT_SUCCESS)

            case let .snapshot(app, textLimit, treeLimits):
                let service = ComputerUseService()
                let text = try service.getAppState(app: app, textLimit: textLimit, treeLimits: treeLimits).primaryText ?? ""
                return CLIProxyResponse(stdout: text + "\n", stderr: "", exitCode: EXIT_SUCCESS)

            case let .call(invocation):
                let output = try runOpenComputerUseCall(invocation)
                return CLIProxyResponse(
                    stdout: try output.jsonText() + "\n",
                    stderr: "",
                    exitCode: output.hasToolError ? EXIT_FAILURE : EXIT_SUCCESS
                )

            default:
                return CLIProxyResponse(stdout: "", stderr: "Unsupported proxied command.\n", exitCode: EXIT_FAILURE)
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            return CLIProxyResponse(stdout: "", stderr: message + "\n", exitCode: EXIT_FAILURE)
        }
    }
}

private final class HistoryStreamWriter: @unchecked Sendable {
    private let output: UnsafeMutablePointer<FILE>
    private let lock = NSLock()
    private var pending: [String] = []
    private var ready = false
    private var closed = false

    init(output: UnsafeMutablePointer<FILE>) { self.output = output }

    func event(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        if ready { writeAgentLine(line, to: output) }
        else { pending.append(line) }
    }

    func accept() {
        lock.lock()
        defer { lock.unlock() }
        writeAgentLine(["ok": true], to: output)
        for line in pending { writeAgentLine(line, to: output) }
        pending.removeAll()
        ready = true
    }

    func fail(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        writeAgentLine(["error": message], to: output)
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        fclose(output)
    }
}

private enum AppAgentEnvironment {
    private static let lock = NSLock()

    static func withOverrides<T>(_ overrides: [String: String], _ body: () throws -> T) rethrows -> T {
        guard !overrides.isEmpty else {
            return try body()
        }

        lock.lock()
        defer { lock.unlock() }

        let previousValues = Dictionary(
            uniqueKeysWithValues: overrides.keys.map { key in
                (key, ProcessInfo.processInfo.environment[key])
            }
        )
        for (key, value) in overrides {
            setenv(key, value, 1)
        }

        defer {
            for (key, previousValue) in previousValues {
                if let previousValue {
                    setenv(key, previousValue, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        return try body()
    }
}

private final class AppAgentSocketClient: @unchecked Sendable {
    private let file: UnsafeMutablePointer<FILE>

    private init(file: UnsafeMutablePointer<FILE>) {
        self.file = file
    }

    deinit {
        fclose(file)
    }

    static func connect(path: String) -> AppAgentSocketClient? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            return nil
        }
        suppressBrokenPipeSignal(fd)

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        let copied = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathCapacity) { buffer -> Bool in
                let bytes = Array(path.utf8)
                guard bytes.count < pathCapacity else {
                    return false
                }
                for index in 0..<bytes.count {
                    buffer[index] = CChar(bitPattern: bytes[index])
                }
                buffer[bytes.count] = 0
                return true
            }
        }

        guard copied else {
            close(fd)
            return nil
        }

        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0, let file = fdopen(fd, "r+") else {
            close(fd)
            return nil
        }

        return AppAgentSocketClient(file: file)
    }

    func request(_ object: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        guard let line = String(data: data, encoding: .utf8) else {
            throw ComputerUseError.message("Failed to encode app-agent request.")
        }

        writeAgentLine(line, to: file)

        guard let responseLine = readAgentLine(file),
              let response = try JSONSerialization.jsonObject(with: Data(responseLine.utf8)) as? [String: Any]
        else {
            throw ComputerUseError.message("Memmy Computer Use.app agent closed the connection.")
        }

        if let error = response["error"] as? String {
            throw ComputerUseError.message(error)
        }

        return response
    }

    func isCurrentAgent(for appURL: URL) throws -> Bool {
        let response = try request(["kind": "agentInfo"])
        let expectedBundleURL = appURL.standardizedFileURL

        guard response["bundleURL"] as? String == expectedBundleURL.path else {
            return false
        }

        guard let processStartTime = response["processStartTime"] as? TimeInterval else {
            return false
        }

        guard let executableURL = executableURL(for: expectedBundleURL),
              let modifiedAt = try? executableURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        else {
            return true
        }

        return processStartTime + 0.5 >= modifiedAt.timeIntervalSince1970
    }

    func streamHistory() throws {
        writeAgentLine(["kind": "historyObserve"], to: file)
        guard let line = readAgentLine(file),
              let response = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        else {
            throw ComputerUseError.message("Memmy Computer Use.app closed the History connection.")
        }
        if let error = response["error"] as? String {
            throw ComputerUseError.message(error)
        }
        guard response["ok"] as? Bool == true else {
            throw ComputerUseError.message("Memmy Computer Use.app rejected the History connection.")
        }
        while let eventLine = readAgentLine(file) {
            FileHandle.standardOutput.write(Data((eventLine + "\n").utf8))
        }
        throw ComputerUseError.message("Memmy Computer History stream disconnected unexpectedly.")
    }

    private func executableURL(for appURL: URL) -> URL? {
        guard let bundle = Bundle(url: appURL),
              let executableName = bundle.object(forInfoDictionaryKey: kCFBundleExecutableKey as String) as? String,
              !executableName.isEmpty
        else {
            return nil
        }

        return appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(executableName)
            .standardizedFileURL
    }
}

private func suppressBrokenPipeSignal(_ fd: Int32) {
    var enabled: Int32 = 1
    _ = withUnsafePointer(to: &enabled) {
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, $0, socklen_t(MemoryLayout<Int32>.size))
    }
}

private func readAgentLine(_ file: UnsafeMutablePointer<FILE>) -> String? {
    var bytes: [UInt8] = []

    while true {
        let character = fgetc(file)
        if character == EOF {
            return bytes.isEmpty ? nil : String(data: Data(bytes), encoding: .utf8)
        }
        if character == 10 {
            return String(data: Data(bytes), encoding: .utf8)
        }
        bytes.append(UInt8(character))
    }
}

private func writeAgentLine(_ object: [String: Any], to file: UnsafeMutablePointer<FILE>) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
       let line = String(data: data, encoding: .utf8)
    {
        writeAgentLine(line, to: file)
    }
}

private func writeAgentLine(_ line: String, to file: UnsafeMutablePointer<FILE>) {
    let output = line + "\n"
    _ = output.withCString { pointer in
        fputs(pointer, file)
    }
    fflush(file)
}
