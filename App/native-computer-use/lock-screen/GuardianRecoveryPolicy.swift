import Foundation

/// Pure lease state for the separate lock guardian. The SecurityAgent allow
/// reply is withheld until `consume` has been acknowledged by the guardian.
struct GuardianRecoveryPolicy {
    enum Screen { case locked, unlocked, unavailable }
    enum Decision: Equatable { case wait, requestLock, finished }

    private(set) var leaseID: UUID?
    private(set) var consumed = false
    private(set) var intervened = false
    private var observedUnlock = false
    private var parentGoneAt: TimeInterval?
    private var lockAttempts = 0
    private var lastLockAttempt: TimeInterval = 0

    mutating func arm(_ id: UUID, screen: Screen) -> Bool {
        guard leaseID == nil, screen == .locked else { return false }
        leaseID = id
        consumed = false
        intervened = false
        observedUnlock = false
        parentGoneAt = nil
        lockAttempts = 0
        lastLockAttempt = 0
        return true
    }

    mutating func consume(_ id: UUID) -> Bool {
        guard leaseID == id, !intervened else { return false }
        consumed = true
        return true
    }

    func isActive(_ id: UUID) -> Bool {
        leaseID == id && !intervened
    }

    mutating func disarm(_ id: UUID) {
        if leaseID == id { leaseID = nil; consumed = false }
    }

    mutating func physicalInputDetected() {
        if leaseID != nil { intervened = true }
    }

    mutating func parentDisconnected(now: TimeInterval) {
        parentGoneAt = now
    }

    mutating func observe(screen: Screen, now: TimeInterval) -> Decision {
        guard leaseID != nil else { return .finished }
        if intervened { return parentGoneAt == nil ? .wait : .finished }
        if consumed && screen == .unlocked { observedUnlock = true }
        if observedUnlock && screen == .locked {
            leaseID = nil
            consumed = false
            return .finished
        }
        guard let parentGoneAt else { return .wait }
        if now - parentGoneAt >= 20 { return .finished }
        guard consumed, screen == .unlocked, lockAttempts < 5,
              lockAttempts == 0 || now - lastLockAttempt >= 1 else { return .wait }
        lockAttempts += 1
        lastLockAttempt = now
        return .requestLock
    }
}
