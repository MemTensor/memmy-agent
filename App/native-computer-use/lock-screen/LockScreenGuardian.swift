import CoreGraphics
import Darwin
import Foundation
import Security

/// Separate from the Computer Use helper so a helper crash cannot discard the
/// last relock attempt. This executable is only launched by the signed helper.
@main struct LockScreenGuardian {
    private static let selfRequirement = "identifier \"cn.memtensor.memmy.computeruse.guardian\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""
    private static let parentRequirement = "identifier \"cn.memtensor.memmy\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""

    static func main() {
        guard CommandLine.arguments.count == 2,
              let parentPID = pid_t(CommandLine.arguments[1]), parentPID > 0,
              getppid() == parentPID,
              signedSelf(), signedParent(parentPID) else { exit(1) }

        let state = GuardianState()
        let monitor = PhysicalInputMonitor(trustedSyntheticPID: parentPID) {
            state.physicalInputDetected()
        }
        monitor.start()
        for _ in 0..<40 {
            if monitor.isActive { break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        guard monitor.isActive else { exit(1) }
        send("READY")

        while let line = readLine() {
            let words = line.split(separator: " ", omittingEmptySubsequences: true)
            guard words.count == 2, let id = UUID(uuidString: String(words[1])),
                  monitor.isActive else {
                send("DENIED")
                continue
            }
            switch words[0] {
            case "ARM":
                send(state.arm(id, screen: screenState()) ? "ARMED \(id.uuidString)" : "DENIED")
            case "CONSUME":
                send(state.consume(id) ? "CONSUMED \(id.uuidString)" : "DENIED")
            case "STATUS":
                send(state.isActive(id) ? "ACTIVE \(id.uuidString)" : "PAUSED")
            case "DISARM":
                state.disarm(id)
                send("DISARMED \(id.uuidString)")
            default:
                send("DENIED")
            }
        }

        // Pipe EOF means the signed helper exited or crashed. An ARM alone is
        // insufficient: only a SecurityAgent check acknowledged by CONSUME may
        // cause relock. Keep watching for a delayed unlock for one lease window.
        state.parentDisconnected(now: ProcessInfo.processInfo.systemUptime)
        for _ in 0..<100 {
            let decision = state.observe(screen: screenState(), now: ProcessInfo.processInfo.systemUptime)
            if decision == .finished { break }
            if decision == .requestLock { postLockShortcut() }
            Thread.sleep(forTimeInterval: 0.2)
        }
        monitor.stop()
    }

    private static func screenState() -> GuardianRecoveryPolicy.Screen {
        guard let properties = CGSessionCopyCurrentDictionary() as? [String: Any] else { return .unavailable }
        if properties["CGSSessionScreenIsLocked"] as? Bool == true { return .locked }
        let onConsole = (properties[kCGSessionOnConsoleKey as String] as? Bool)
            ?? (properties["kCGSSessionOnConsoleKey"] as? Bool)
        let loginDone = properties[kCGSessionLoginDoneKey as String] as? Bool
        return onConsole == true && loginDone == true ? .unlocked : .unavailable
    }

    private static func postLockShortcut() {
        let source = CGEventSource(stateID: .privateState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: false)
        down?.flags = [.maskControl, .maskCommand]
        up?.flags = [.maskControl, .maskCommand]
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private static func send(_ line: String) {
        fputs(line + "\n", stdout)
        fflush(stdout)
    }

    private static func signedSelf() -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code,
              let requirement = requirement(selfRequirement) else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    private static func signedParent(_ pid: pid_t) -> Bool {
        let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess,
              let code, let requirement = requirement(parentRequirement) else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    private static func requirement(_ text: String) -> SecRequirement? {
        var value: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &value) == errSecSuccess else { return nil }
        return value
    }
}

private final class GuardianState: @unchecked Sendable {
    private let lock = NSLock()
    private var policy = GuardianRecoveryPolicy()

    func arm(_ id: UUID, screen: GuardianRecoveryPolicy.Screen) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return policy.arm(id, screen: screen)
    }
    func consume(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return policy.consume(id)
    }
    func isActive(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return policy.isActive(id)
    }
    func disarm(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        policy.disarm(id)
    }
    func physicalInputDetected() {
        lock.lock(); defer { lock.unlock() }
        policy.physicalInputDetected()
    }
    func parentDisconnected(now: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        policy.parentDisconnected(now: now)
    }
    func observe(screen: GuardianRecoveryPolicy.Screen, now: TimeInterval) -> GuardianRecoveryPolicy.Decision {
        lock.lock(); defer { lock.unlock() }
        return policy.observe(screen: screen, now: now)
    }
}
