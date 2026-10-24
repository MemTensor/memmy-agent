import XCTest
@testable import MemmyComputerUseKit

final class TaskNotificationIsolationTests: XCTestCase {
    func testTurnEndTargetsOnlyTheOwnedAgentSocket() {
        let first = [openComputerUseAppAgentSocketNamespaceEnvironmentKey: "memmy:app:task:first"]
        let second = [openComputerUseAppAgentSocketNamespaceEnvironmentKey: "memmy:app:task:second"]

        XCTAssertEqual(
            openComputerUseTurnEndedNotificationObject(environment: first),
            openComputerUseAppAgentSocketFileName(namespace: first[openComputerUseAppAgentSocketNamespaceEnvironmentKey])
        )
        XCTAssertNotEqual(
            openComputerUseTurnEndedNotificationObject(environment: first),
            openComputerUseTurnEndedNotificationObject(environment: second)
        )
    }

    func testUnnamespacedTurnEndCannotAddressManagedAgent() {
        let managed = [openComputerUseAppAgentSocketNamespaceEnvironmentKey: "memmy:app:task:first"]
        XCTAssertEqual(openComputerUseTurnEndedNotificationObject(environment: [:]), "memmy-computer-use-agent.sock")
        XCTAssertNotEqual(
            openComputerUseTurnEndedNotificationObject(environment: [:]),
            openComputerUseTurnEndedNotificationObject(environment: managed)
        )
    }
}
