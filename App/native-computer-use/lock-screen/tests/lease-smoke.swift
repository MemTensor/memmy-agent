import Foundation

@main struct LeaseSmoke {
    static func main() {
        let lease = LockScreenLease()
        precondition(!lease.hasPendingLease)
        precondition(lease.begin(threadID: "turn", interactive: false, userApproved: true,
                                 now: 1, inputIdle: 8) == nil)
        precondition(lease.begin(threadID: "turn", interactive: true, userApproved: false,
                                 now: 1, inputIdle: 8) == nil)
        precondition(lease.begin(threadID: "turn", interactive: true, userApproved: true,
                                 now: 1, inputIdle: 8) != nil)
        precondition(lease.hasPendingLease)
        precondition(lease.consume(now: 2, inputIdle: 9, screenIsLocked: true))
        precondition(!lease.hasPendingLease)
        precondition(!lease.consume(now: 2, inputIdle: 9, screenIsLocked: true))
        precondition(lease.begin(threadID: "turn", interactive: true, userApproved: true,
                                 now: 3, inputIdle: 10) != nil)
        precondition(!lease.consume(now: 4, inputIdle: 0.1, screenIsLocked: true))
        precondition(lease.begin(threadID: "turn", interactive: true, userApproved: true,
                                 now: 5, inputIdle: 1) == nil)
        print("authorization lease and physical-input pause passed")
    }
}
