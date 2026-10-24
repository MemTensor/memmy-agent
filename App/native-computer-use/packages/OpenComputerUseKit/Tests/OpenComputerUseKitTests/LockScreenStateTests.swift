import XCTest
@testable import MemmyComputerUseKit

final class LockScreenStateTests: XCTestCase {
    func testLockedSessionRejectsAppStateBeforeResolvingTarget() {
        let service = ComputerUseService(lockScreenState: { .locked })
        XCTAssertThrowsError(try service.getAppState(app: "com.apple.TextEdit")) { error in
            XCTAssertTrue((error as? ComputerUseError)?.errorDescription?.contains("Mac is locked") == true)
        }
    }

    func testUnavailableSessionRejectsInputBeforeDispatch() {
        let service = ComputerUseService(lockScreenState: { .unavailable })
        XCTAssertThrowsError(try service.typeText(app: "com.apple.TextEdit", text: "must not type")) { error in
            XCTAssertTrue((error as? ComputerUseError)?.errorDescription?.contains("could not verify") == true)
        }
    }

    func testSessionStateRequiresConsoleAndLogin() {
        XCTAssertEqual(LockScreenState.fromSession(nil), .unavailable)
        XCTAssertEqual(LockScreenState.fromSession(["CGSSessionScreenIsLocked": true]), .locked)
        XCTAssertEqual(LockScreenState.fromSession([
            "kCGSSessionOnConsoleKey": true,
            "kCGSessionLoginDoneKey": true,
        ]), .unlocked)
        XCTAssertEqual(LockScreenState.fromSession([
            "kCGSSessionOnConsoleKey": false,
            "kCGSessionLoginDoneKey": true,
        ]), .unavailable)
    }
}
