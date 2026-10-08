import Darwin
import Foundation
import Security

/// A signed companion keeps the recovery lease if the helper exits abruptly.
/// The pipe is inherited only by that child; EOF is the helper death signal.
final class LockScreenGuardianClient: @unchecked Sendable {
    enum Status { case active, intervened, unavailable }
    private let process: Process
    private let input: FileHandle
    private let output: FileHandle
    private let commandLock = NSLock()

    private init(process: Process, input: FileHandle, output: FileHandle) {
        self.process = process
        self.input = input
        self.output = output
    }

    static func start() throws -> LockScreenGuardianClient {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/SharedSupport/lock-guardian")
        guard signedGuardian(executable) else { throw GuardianError.invalidSignature }
        let process = Process()
        process.executableURL = executable
        process.arguments = [String(getpid())]
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        let client = LockScreenGuardianClient(process: process,
            input: stdin.fileHandleForWriting, output: stdout.fileHandleForReading)
        // An EPIPE must return an error rather than terminate the helper.
        guard fcntl(client.input.fileDescriptor, F_SETNOSIGPIPE, 1) == 0,
              client.readLine(timeoutMilliseconds: 2_000) == "READY", process.isRunning else {
            client.close()
            throw GuardianError.notReady
        }
        return client
    }

    var isRunning: Bool { process.isRunning }

    func arm(_ id: UUID) -> Bool { send("ARM \(id.uuidString)", expect: "ARMED \(id.uuidString)") }
    func consume(_ id: UUID) -> Bool { send("CONSUME \(id.uuidString)", expect: "CONSUMED \(id.uuidString)") }
    func status(_ id: UUID) -> Status {
        switch exchange("STATUS \(id.uuidString)") {
        case "ACTIVE \(id.uuidString)": return .active
        case "PAUSED": return .intervened
        default: return .unavailable
        }
    }
    func disarm(_ id: UUID) { _ = send("DISARM \(id.uuidString)", expect: "DISARMED \(id.uuidString)") }

    func close() {
        commandLock.lock()
        defer { commandLock.unlock() }
        try? input.close()
        try? output.close()
    }

    private func send(_ line: String, expect: String) -> Bool {
        exchange(line) == expect
    }

    private func exchange(_ line: String) -> String? {
        commandLock.lock()
        defer { commandLock.unlock() }
        guard process.isRunning else { return nil }
        do { try input.write(contentsOf: Data((line + "\n").utf8)) }
        catch { return nil }
        let response = readLine(timeoutMilliseconds: 500)
        return process.isRunning ? response : nil
    }

    private func readLine(timeoutMilliseconds: Int32) -> String? {
        let deadline = ProcessInfo.processInfo.systemUptime + Double(timeoutMilliseconds) / 1000
        var bytes: [UInt8] = []
        while bytes.count < 128 {
            let remaining = Int32(max(0, (deadline - ProcessInfo.processInfo.systemUptime) * 1000))
            if remaining == 0 { return nil }
            var event = pollfd(fd: output.fileDescriptor, events: Int16(POLLIN), revents: 0)
            guard Darwin.poll(&event, 1, remaining) == 1 else { return nil }
            var byte: UInt8 = 0
            guard Darwin.read(output.fileDescriptor, &byte, 1) == 1 else { return nil }
            if byte == 10 { return String(bytes: bytes, encoding: .utf8) }
            bytes.append(byte)
        }
        return nil
    }

    private static func signedGuardian(_ url: URL) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &code) == errSecSuccess,
              let code else { return false }
        let text = "identifier \"cn.memtensor.memmy.computeruse.guardian\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }
}

private enum GuardianError: Error {
    case invalidSignature
    case notReady
}
