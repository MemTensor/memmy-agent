import Foundation

@main struct GuardianPolicySmoke {
    static func main() {
        let id = UUID()
        var policy = GuardianRecoveryPolicy()
        precondition(!policy.arm(id, screen: .unlocked))
        precondition(policy.arm(id, screen: .locked))
        precondition(!policy.arm(UUID(), screen: .locked))
        policy.parentDisconnected(now: 1)
        precondition(policy.observe(screen: .unlocked, now: 2) == .wait,
                     "A lease never consumed by SecurityAgent cannot lock the user")

        policy = GuardianRecoveryPolicy()
        precondition(policy.arm(id, screen: .locked))
        precondition(policy.consume(id))
        precondition(policy.isActive(id))
        precondition(!policy.consume(UUID()))
        policy.parentDisconnected(now: 1)
        precondition(policy.observe(screen: .locked, now: 2) == .wait)
        precondition(policy.observe(screen: .unlocked, now: 3) == .requestLock)
        precondition(policy.observe(screen: .unlocked, now: 3.5) == .wait)
        precondition(policy.observe(screen: .unlocked, now: 4) == .requestLock)
        precondition(policy.observe(screen: .locked, now: 4.5) == .finished)

        policy = GuardianRecoveryPolicy()
        precondition(policy.arm(id, screen: .locked))
        precondition(policy.consume(id))
        policy.parentDisconnected(now: 1)
        for second in 2...6 {
            precondition(policy.observe(screen: .unlocked, now: Double(second)) == .requestLock)
        }
        precondition(policy.observe(screen: .unlocked, now: 7) == .wait,
                     "Recovery attempts are bounded")

        policy = GuardianRecoveryPolicy()
        precondition(policy.arm(id, screen: .locked))
        precondition(policy.consume(id))
        policy.disarm(id)
        policy.parentDisconnected(now: 1)
        precondition(policy.observe(screen: .unlocked, now: 2) == .finished)

        policy = GuardianRecoveryPolicy()
        precondition(policy.arm(id, screen: .locked))
        precondition(policy.consume(id))
        policy.physicalInputDetected()
        precondition(!policy.isActive(id))
        policy.parentDisconnected(now: 1)
        precondition(policy.observe(screen: .unlocked, now: 2) == .finished,
                     "User takeover prevents guardian relock")

        policy = GuardianRecoveryPolicy()
        precondition(policy.arm(id, screen: .locked))
        precondition(policy.consume(id))
        policy.parentDisconnected(now: 1)
        precondition(policy.observe(screen: .unavailable, now: 2) == .wait)
        precondition(policy.observe(screen: .unlocked, now: 21) == .finished,
                     "Guardian stops after its recovery window")
        print("guardian recovery policy passed")
    }
}
