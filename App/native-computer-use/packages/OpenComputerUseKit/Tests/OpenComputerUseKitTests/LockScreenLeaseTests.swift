import XCTest
@testable import MemmyComputerUseKit

final class LockScreenLeaseTests: XCTestCase {
    func testOnlyOneInteractiveApprovedRequestCanUnlockOnce() {
        let lease = LockScreenLease()
        XCTAssertNil(lease.begin(threadID: "thread", interactive: false, userApproved: true,
                                 now: 1, inputIdle: 20))
        XCTAssertNil(lease.begin(threadID: "thread", interactive: true, userApproved: false,
                                 now: 1, inputIdle: 20))
        XCTAssertNotNil(lease.begin(threadID: "thread", interactive: true, userApproved: true,
                                    now: 1, inputIdle: 20))
        XCTAssertNil(lease.begin(threadID: "other", interactive: true, userApproved: true,
                                 now: 2, inputIdle: 21))
        XCTAssertTrue(lease.consume(now: 2, inputIdle: 21, screenIsLocked: true))
        XCTAssertFalse(lease.consume(now: 2, inputIdle: 21, screenIsLocked: true))
    }

    func testPhysicalInputPausesFutureLeasesUntilManualReset() {
        let lease = LockScreenLease()
        XCTAssertNotNil(lease.begin(threadID: "thread", interactive: true, userApproved: true,
                                    now: 1, inputIdle: 20))
        XCTAssertFalse(lease.consume(now: 2, inputIdle: 0.2, screenIsLocked: true))
        XCTAssertNil(lease.begin(threadID: "thread", interactive: true, userApproved: true,
                                 now: 3, inputIdle: 1))
        lease.resetAfterUserUnlock()
        XCTAssertNotNil(lease.begin(threadID: "thread", interactive: true, userApproved: true,
                                    now: 4, inputIdle: 2))
        lease.physicalInputDetected()
        XCTAssertFalse(lease.consume(now: 5, inputIdle: 3, screenIsLocked: true))
    }

    func testExpiredAndCancelledLeasesDeny() {
        let lease = LockScreenLease()
        let id = lease.begin(threadID: "thread", interactive: true, userApproved: true,
                             now: 1, inputIdle: 20)!
        lease.cancel(id)
        XCTAssertFalse(lease.consume(now: 2, inputIdle: 21, screenIsLocked: true))
        XCTAssertNotNil(lease.begin(threadID: "thread", interactive: true, userApproved: true,
                                    now: 3, inputIdle: 22))
        XCTAssertFalse(lease.consume(now: 20, inputIdle: 39, screenIsLocked: true))
    }
}
