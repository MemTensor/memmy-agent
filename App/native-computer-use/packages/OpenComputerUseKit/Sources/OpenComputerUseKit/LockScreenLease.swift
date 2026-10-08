import Foundation

/// An authorization plug-in may permit one screen unlock only while a trusted,
/// interactive Computer Use request owns this lease. No password is involved.
public final class LockScreenLease: @unchecked Sendable {
    private struct Pending {
        let id: UUID
        let threadID: String
        let issuedAt: TimeInterval
        let expiresAt: TimeInterval
        let inputIdleAtIssue: TimeInterval
    }

    private let lock = NSLock()
    private var pending: Pending?
    private var physicalInputPaused = false

    public init() {}

    public var hasPendingLease: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending != nil
    }

    @discardableResult
    public func begin(threadID: String, interactive: Bool, userApproved: Bool,
                      now: TimeInterval, inputIdle: TimeInterval,
                      lifetime: TimeInterval = 15) -> UUID? {
        lock.lock()
        defer { lock.unlock() }
        guard interactive, userApproved, !physicalInputPaused,
              !threadID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              now.isFinite, inputIdle.isFinite, inputIdle >= 0,
              lifetime.isFinite, (0...15).contains(lifetime), lifetime > 0,
              pending == nil else { return nil }
        let item = Pending(id: UUID(), threadID: threadID, issuedAt: now,
                           expiresAt: now + lifetime, inputIdleAtIssue: inputIdle)
        pending = item
        return item.id
    }

    public func consume(now: TimeInterval, inputIdle: TimeInterval,
                        screenIsLocked: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let item = pending else { return false }
        // A failed check destroys the lease. A second authorization request
        // cannot reuse it, even if the first one did not unlock the screen.
        pending = nil
        guard screenIsLocked, !physicalInputPaused,
              now.isFinite, now >= item.issuedAt, now <= item.expiresAt,
              inputIdle.isFinite, inputIdle >= 0 else { return false }
        let elapsed = now - item.issuedAt
        if inputIdle + 0.15 < item.inputIdleAtIssue + elapsed {
            physicalInputPaused = true
            return false
        }
        return true
    }

    public func cancel(_ id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        if pending?.id == id { pending = nil }
    }

    public func physicalInputDetected() {
        lock.lock()
        physicalInputPaused = true
        pending = nil
        lock.unlock()
    }

    /// Requires a fresh interactive request after the user finishes intervening.
    public func resetAfterUserUnlock() {
        lock.lock()
        physicalInputPaused = false
        pending = nil
        lock.unlock()
    }
}
