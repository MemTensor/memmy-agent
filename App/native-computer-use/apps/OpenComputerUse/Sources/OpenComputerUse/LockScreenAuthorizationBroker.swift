import CoreGraphics
import Darwin
import Foundation
import MemmyComputerUseKit
import Security

/// The SecurityAgent plug-in contacts this service over a local socket. This
/// broker is inert until a host-approved interactive request begins a lease.
final class LockScreenAuthorizationBroker: @unchecked Sendable {
    static let shared = LockScreenAuthorizationBroker()
    static let socketDirectory = "/tmp/cn.memtensor.memmy.computeruse"
    static let socketPath = socketDirectory + "/LockScreenAuthorization.sock"

    private let state = NSLock()
    private let lease = LockScreenLease()
    private var guardian: LockScreenGuardianClient?
    private var inputMonitor: PhysicalInputMonitor?
    private var lifecycleTimer: DispatchSourceTimer?
    private var lastLockState: LockScreenState = .unavailable
    private var automaticUnlockPending = false
    private var activeRequestID: UUID?
    private var activeRequestStarted: TimeInterval = 0
    private var autoUnlocked = false
    private var userIntervened = false
    private var relockRequested = false
    private var releaseRequested = false
    private var relockAttempts = 0
    private var lastRelockAttempt: TimeInterval = 0
    private var descriptor: Int32 = -1
    private var running = false

    private init() {}

    /// An ad-hoc/development helper must never answer a SecurityAgent right.
    /// macOS validates the plug-in's client as well; this checks the server
    /// before creating its world-connectable socket.
    static func isSignedReleaseProcess() -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return false }
        var requirement: SecRequirement?
        let requirementText = "identifier \"cn.memtensor.memmy\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""
        guard SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    func start() throws {
        guard Self.isSignedReleaseProcess() else { throw BrokerError.unsignedHelper }
        state.lock()
        defer { state.unlock() }
        if running { return }
        try prepareSocketDirectory()

        var old = stat()
        if lstat(Self.socketPath, &old) == 0 {
            guard old.st_uid == geteuid(), old.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else {
                throw BrokerError.unsafeSocketPath
            }
            // A prior helper instance must be gone before replacing its socket.
            let probe = socket(AF_UNIX, SOCK_STREAM, 0)
            if probe >= 0 {
                var address = socketAddress()
                let connected = withUnsafePointer(to: &address) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                    }
                } == 0
                Darwin.close(probe)
                if connected { throw BrokerError.alreadyRunning }
            }
            guard unlink(Self.socketPath) == 0 else { throw BrokerError.unsafeSocketPath }
        }

        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        guard server >= 0 else { throw BrokerError.socketUnavailable }
        var address = socketAddress()
        let didBind = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        } == 0
        guard didBind, chmod(Self.socketPath, 0o666) == 0,
              Darwin.listen(server, 4) == 0 else {
            Darwin.close(server)
            unlink(Self.socketPath)
            throw BrokerError.socketUnavailable
        }
        let guardian: LockScreenGuardianClient
        do { guardian = try LockScreenGuardianClient.start() }
        catch {
            Darwin.close(server)
            unlink(Self.socketPath)
            throw error
        }
        self.guardian = guardian
        descriptor = server
        running = true
        let monitor = PhysicalInputMonitor { [weak self] in self?.externalInputDetected() }
        inputMonitor = monitor
        monitor.start()
        lastLockState = LockScreenState.current()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
        timer.setEventHandler { [weak self] in self?.observeLockState() }
        lifecycleTimer = timer
        timer.resume()
        DispatchQueue.global(qos: .utility).async { [weak self] in self?.acceptLoop(server) }
    }

    /// `userApproved` must come from Memmy's own consent UI, never from an
    /// Agent argument. A session must be linked to a live interactive message.
    func beginLease(threadID: String, interactive: Bool, userApproved: Bool) -> UUID? {
        guard inputMonitor?.isActive == true else { return nil }
        state.lock()
        defer { state.unlock() }
        guard activeRequestID == nil, let guardian, guardian.isRunning else { return nil }
        let now = ProcessInfo.processInfo.systemUptime
        guard let id = lease.begin(threadID: threadID, interactive: interactive, userApproved: userApproved,
                                   now: now, inputIdle: inputIdle()) else { return nil }
        guard guardian.arm(id) else {
            lease.cancel(id)
            return nil
        }
        activeRequestID = id
        activeRequestStarted = now
        userIntervened = false
        autoUnlocked = false
        relockRequested = false
        releaseRequested = false
        relockAttempts = 0
        lastRelockAttempt = 0
        return id
    }

    func cancelLease(_ id: UUID) {
        state.lock()
        let matched = activeRequestID == id
        let wasConsumed = matched && (automaticUnlockPending || autoUnlocked)
        if matched {
            if wasConsumed { releaseRequested = true }
            else { activeRequestID = nil }
        }
        state.unlock()
        lease.cancel(id)
        if matched && !wasConsumed { guardian?.disarm(id) }
        if wasConsumed { requestRelockIfReady() }
    }
    func physicalInputDetected() { lease.physicalInputDetected() }
    func userManuallyUnlocked() { lease.resetAfterUserUnlock() }

    private func externalInputDetected() {
        state.lock()
        let id = activeRequestID
        let active = id != nil
        if active { userIntervened = true }
        state.unlock()
        if let id { guardian?.disarm(id) }
        if active { physicalInputDetected() }
    }

    func stop() {
        state.lock()
        let server = descriptor
        let monitor = inputMonitor
        let timer = lifecycleTimer
        let guardian = self.guardian
        let pendingID = activeRequestID
        self.guardian = nil
        // A normal helper shutdown can happen before the host releases its
        // lease. Request a lock while this process can still post HID events.
        // The companion also remains armed until it sees helper pipe EOF.
        let shouldRelock = autoUnlocked && !userIntervened
        inputMonitor = nil
        lifecycleTimer = nil
        automaticUnlockPending = false
        activeRequestID = nil
        autoUnlocked = false
        userIntervened = false
        relockRequested = false
        releaseRequested = false
        relockAttempts = 0
        lastRelockAttempt = 0
        lastLockState = .unavailable
        descriptor = -1
        running = false
        state.unlock()
        if let pendingID { lease.cancel(pendingID) }
        if shouldRelock && LockScreenState.current() == .unlocked { postLockShortcut() }
        // Leave a consumed lease armed across pipe EOF. The independent
        // process observes helper death and retries the lock if needed.
        guardian?.close()
        if server >= 0 {
            Darwin.close(server)
            unlink(Self.socketPath)
        }
        monitor?.stop()
        timer?.cancel()
    }

    private func acceptLoop(_ server: Int32) {
        while true {
            state.lock()
            let active = running && descriptor == server
            state.unlock()
            if !active { break }
            let client = Darwin.accept(server, nil, nil)
            if client < 0 { break }
            var timeout = timeval(tv_sec: 1, tv_usec: 0)
            _ = withUnsafePointer(to: &timeout) {
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, $0, socklen_t(MemoryLayout<timeval>.size))
            }
            var request = [UInt8](repeating: 0, count: 3)
            let readCount = request.withUnsafeMutableBytes { Darwin.read(client, $0.baseAddress, 3) }
            if readCount == 3 && request == Array("H1\n".utf8) {
                serveSignedHost(client)
            } else {
                let validProtocol = readCount == 3 && request == Array("V1\n".utf8)
                var allowed = validProtocol && inputMonitor?.isActive == true && lease.consume(
                    now: ProcessInfo.processInfo.systemUptime,
                    inputIdle: inputIdle(),
                    screenIsLocked: LockScreenState.current() == .locked
                )
                if allowed {
                    state.lock()
                    let id = activeRequestID
                    state.unlock()
                    // Guardian acknowledgement precedes SecurityAgent allow.
                    // A helper crash after this point cannot lose the lease.
                    let acknowledged = id.map { guardian?.consume($0) == true } ?? false
                    state.lock()
                    allowed = acknowledged && activeRequestID == id && !userIntervened
                    if allowed { automaticUnlockPending = true }
                    state.unlock()
                    if !allowed, let id {
                        guardian?.disarm(id)
                        cancelLease(id)
                    }
                }
                var reply: UInt8 = allowed ? 49 : 48
                _ = Darwin.write(client, &reply, 1)
            }
            Darwin.close(client)
        }
    }

    private func observeLockState() {
        let current = LockScreenState.current()
        let now = ProcessInfo.processInfo.systemUptime
        state.lock()
        let previous = lastLockState
        let auto = automaticUnlockPending
        let relockedLeaseID = previous == .unlocked && current == .locked && autoUnlocked
            ? activeRequestID : nil
        if current != .unavailable { lastLockState = current }
        if previous == .locked && current == .unlocked {
            automaticUnlockPending = false
            if auto {
                autoUnlocked = true
                activeRequestStarted = now
            }
        }
        // A user, macOS, or our shortcut may lock the session before release
        // arrives. In every case the auto-unlocked lease is over; retaining it
        // would deny all later requests until the helper restarts.
        if relockedLeaseID != nil {
            activeRequestID = nil
            automaticUnlockPending = false
            autoUnlocked = false
            relockRequested = false
            releaseRequested = false
            relockAttempts = 0
            lastRelockAttempt = 0
            userIntervened = false
        }
        let timedOut = activeRequestID != nil && now - activeRequestStarted > (autoUnlocked ? 30 : 20)
        let guardianLost = guardian?.isRunning != true
        let shouldRelock = (timedOut || releaseRequested || guardianLost)
            && autoUnlocked && !userIntervened && !relockRequested
        if shouldRelock {
            relockRequested = true
            relockAttempts = 1
            lastRelockAttempt = now
        }
        let retryRelock = relockRequested && autoUnlocked && current == .unlocked
            && !userIntervened && now - lastRelockAttempt >= 1 && relockAttempts < 5
        if retryRelock {
            relockAttempts += 1
            lastRelockAttempt = now
        }
        let expired = timedOut && !autoUnlocked && !automaticUnlockPending
        let expiredID = expired ? activeRequestID : nil
        if expired { activeRequestID = nil; automaticUnlockPending = false }
        state.unlock()
        if let relockedLeaseID {
            lease.cancel(relockedLeaseID)
            guardian?.disarm(relockedLeaseID)
        }
        if let expiredID {
            lease.cancel(expiredID)
            guardian?.disarm(expiredID)
        }
        if shouldRelock || retryRelock { postLockShortcut() }
        if previous == .locked && current == .unlocked && !auto {
            userManuallyUnlocked()
        }
    }

    /// Only Memmy's signed main process can mint or cancel a lease. An Agent
    /// tool and a renderer cannot write this protocol on their own.
    private func serveSignedHost(_ client: Int32) {
        guard signedMemmyHost(client), let line = readLine(client, limit: 1024),
              let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
              let action = request["action"] else {
            writeLine(client, "denied")
            return
        }
        observeLockState()
        switch action {
        case "screen-state":
            switch LockScreenState.current() {
            case .locked: writeLine(client, "locked")
            case .unlocked: writeLine(client, "unlocked")
            case .unavailable: writeLine(client, "unavailable")
            }
        case "begin":
            guard let thread = request["thread"], thread.utf8.count <= 512,
                  request["interactive"] == "1", request["userApproved"] == "1",
                  let id = beginLease(threadID: thread, interactive: request["interactive"] == "1",
                                      userApproved: request["userApproved"] == "1") else {
                writeLine(client, "denied")
                return
            }
            writeLine(client, id.uuidString)
        case "wake":
            guard let raw = request["id"], let id = UUID(uuidString: raw),
                  isActiveRequest(id, allowIntervention: false), guardian?.isRunning == true,
                  LockScreenState.current() == .locked else {
                writeLine(client, "denied")
                return
            }
            postWakeKey()
            writeLine(client, "wake-sent")
        case "status":
            guard let raw = request["id"], let id = UUID(uuidString: raw), isActiveRequest(id) else {
                writeLine(client, "denied")
                return
            }
            let guardianStatus = guardian?.status(id) ?? .unavailable
            if guardianStatus == .intervened { externalInputDetected() }
            state.lock()
            if guardianStatus == .unavailable { releaseRequested = true }
            let paused = userIntervened || inputMonitor?.isActive != true || guardianStatus != .active
            let unlockedByMemmy = autoUnlocked
            state.unlock()
            let screen = LockScreenState.current()
            writeLine(client, paused || (screen == .unlocked && !unlockedByMemmy) ? "paused"
                      : unlockedByMemmy && screen == .unlocked ? "auto-unlocked" : "waiting")
        case "release":
            guard let raw = request["id"], let id = UUID(uuidString: raw), isActiveRequest(id) else {
                writeLine(client, "denied")
                return
            }
            if guardian?.status(id) == .intervened { externalInputDetected() }
            state.lock()
            let alreadyRelocking = relockRequested
            let shouldRelock = autoUnlocked && !userIntervened && !alreadyRelocking
            if shouldRelock {
                relockRequested = true
                relockAttempts = 1
                lastRelockAttempt = ProcessInfo.processInfo.systemUptime
            }
            let intervened = userIntervened
            if automaticUnlockPending && !intervened { releaseRequested = true }
            let awaitingUnlock = automaticUnlockPending && !intervened
            if !shouldRelock && !alreadyRelocking && !awaitingUnlock {
                activeRequestID = nil
                automaticUnlockPending = false
            }
            state.unlock()
            if !shouldRelock && !alreadyRelocking { lease.cancel(id) }
            if intervened || (!shouldRelock && !alreadyRelocking && !awaitingUnlock) {
                guardian?.disarm(id)
            }
            if shouldRelock { postLockShortcut() }
            writeLine(client, intervened ? "user-intervened"
                      : shouldRelock || alreadyRelocking ? "relock-sent"
                      : awaitingUnlock ? "relock-pending" : "released")
        case "cancel":
            guard let raw = request["id"], let id = UUID(uuidString: raw) else {
                writeLine(client, "denied")
                return
            }
            cancelLease(id)
            writeLine(client, "cancelled")
        case "physical-input":
            physicalInputDetected()
            writeLine(client, "paused")
        default:
            writeLine(client, "denied")
        }
    }

    private func isActiveRequest(_ id: UUID, allowIntervention: Bool = true) -> Bool {
        state.lock()
        defer { state.unlock() }
        return activeRequestID == id && (allowIntervention || !userIntervened)
    }

    private func requestRelockIfReady() {
        state.lock()
        let shouldRelock = autoUnlocked && !userIntervened && !relockRequested
        if shouldRelock {
            relockRequested = true
            relockAttempts = 1
            lastRelockAttempt = ProcessInfo.processInfo.systemUptime
        }
        state.unlock()
        if shouldRelock { postLockShortcut() }
    }

    private func postWakeKey() {
        let source = CGEventSource(stateID: .privateState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: false)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private func postLockShortcut() {
        // Control-Command-Q is the public macOS Lock Screen shortcut. The
        // broker sends it only for a session that it observed auto-unlock.
        let source = CGEventSource(stateID: .privateState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: false)
        down?.flags = [.maskControl, .maskCommand]
        up?.flags = [.maskControl, .maskCommand]
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private func signedMemmyHost(_ client: Int32) -> Bool {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(client, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid > 0 else { return false }
        let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess,
              let code else { return false }
        var requirement: SecRequirement?
        let text = "identifier \"cn.memtensor.memmy\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""
        guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    private func readLine(_ client: Int32, limit: Int) -> String? {
        var bytes: [UInt8] = []
        while bytes.count < limit {
            var value: UInt8 = 0
            guard Darwin.read(client, &value, 1) == 1 else { return nil }
            if value == 10 { return String(bytes: bytes, encoding: .utf8) }
            bytes.append(value)
        }
        return nil
    }

    private func writeLine(_ client: Int32, _ line: String) {
        let bytes = Array((line + "\n").utf8)
        bytes.withUnsafeBytes { buffer in
            _ = Darwin.write(client, buffer.baseAddress, buffer.count)
        }
    }

    private func inputIdle() -> TimeInterval {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .null)
    }

    private func prepareSocketDirectory() throws {
        if mkdir(Self.socketDirectory, 0o755) != 0 && errno != EEXIST {
            throw BrokerError.unsafeSocketPath
        }
        var info = stat()
        guard lstat(Self.socketDirectory, &info) == 0,
              info.st_uid == geteuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              info.st_mode & 0o022 == 0 else {
            throw BrokerError.unsafeSocketPath
        }
    }

    private func socketAddress() -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        Swift.withUnsafeMutableBytes(of: &address.sun_path) { (bytes: UnsafeMutableRawBufferPointer) -> Void in
            let path = Array(Self.socketPath.utf8CString)
            precondition(path.count <= bytes.count)
            path.withUnsafeBytes { source in bytes.copyMemory(from: source) }
        }
        return address
    }
}

private enum BrokerError: Error {
    case unsignedHelper
    case unsafeSocketPath
    case alreadyRunning
    case socketUnavailable
}
