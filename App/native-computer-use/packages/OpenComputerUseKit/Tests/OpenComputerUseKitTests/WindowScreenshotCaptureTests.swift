import AppKit
import CoreGraphics
import XCTest
@testable import MemmyComputerUseKit

final class WindowScreenshotCaptureTests: XCTestCase {
    private let root = CGRect(x: 0, y: 32, width: 1512, height: 884)
    private let displays = [WindowScreenshotDisplay(id: 1, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982), scale: 2),
                            WindowScreenshotDisplay(id: 2, bounds: CGRect(x: -1440, y: -100, width: 1440, height: 900), scale: 1)]
    private let available = [WindowScreenshotIdentity(id: 10, pid: 42, onScreen: true),
                             WindowScreenshotIdentity(id: 11, pid: 42, onScreen: true),
                             WindowScreenshotIdentity(id: 12, pid: 99, onScreen: true),
                             WindowScreenshotIdentity(id: 13, pid: 42, onScreen: false),
                             WindowScreenshotIdentity(id: 14, pid: 42, onScreen: true)]

    private func plan(_ bounds: CGRect? = nil, onScreen: Bool = true, supportsChildren: Bool = true,
                      displays: [WindowScreenshotDisplay]? = nil, available: [WindowScreenshotIdentity]? = nil,
                      related: Set<CGWindowID> = []) -> WindowScreenshotPlan? {
        windowScreenshotPlan(windowID: 10, pid: 42, bounds: bounds ?? root, onScreen: onScreen,
            supportsChildren: supportsChildren, displays: displays ?? self.displays,
            available: available ?? self.available, relatedWindowIDs: related, fallbackScale: 2)
    }

    func testExactRootUsesItsCGGeometryForRetinaDisplayCrop() throws {
        let actual = try XCTUnwrap(plan(related: [0, 10, 11, 12, 13]))
        XCTAssertEqual(actual.displayID, 1)
        XCTAssertEqual(actual.sourceRect, root)
        XCTAssertEqual(actual.scale, 2)
        XCTAssertEqual(actual.relatedWindowIDs, [11])
        XCTAssertFalse(actual.relatedWindowIDs.contains(14), "Same PID alone is not an association")
    }

    func testMovedRootUsesTopLeftDisplayOriginIncludingNegativeXAndY() throws {
        let moved = CGRect(x: -1200, y: -50, width: 800, height: 600)
        let actual = try XCTUnwrap(plan(moved))
        XCTAssertEqual(actual.displayID, 2)
        XCTAssertEqual(actual.sourceRect, CGRect(x: 240, y: 50, width: 800, height: 600))
        XCTAssertEqual(actual.scale, 1)
        let resized = try XCTUnwrap(plan(CGRect(x: 20, y: 40, width: 900, height: 500)))
        XCTAssertEqual(resized.sourceRect, CGRect(x: 20, y: 40, width: 900, height: 500))
    }

    func testIndependentFallbackNeverExpandsCaptureToWholeDisplayOrApplication() throws {
        for p in [plan(supportsChildren: false), plan(onScreen: false),
                  plan(CGRect(x: -100, y: 50, width: 800, height: 600)),
                  plan(CGRect(x: 1400, y: 50, width: 800, height: 600)),
                  plan(displays: displays + [displays[0]])] {
            let actual = try XCTUnwrap(p)
            XCTAssertNil(actual.displayID)
            XCTAssertEqual(actual.sourceRect, .zero)
        }
    }

    func testReusedOrAmbiguousWindowIDCannotBindEvenWithCorrectGeometry() {
        XCTAssertNil(plan(available: [WindowScreenshotIdentity(id: 10, pid: 99, onScreen: true)]))
        XCTAssertNil(plan(available: available + [available[0]]))
        XCTAssertNil(plan(CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 100)))
        let duplicated = available + [available[1]]
        XCTAssertEqual(plan(available: duplicated, related: [11])?.relatedWindowIDs, [])
    }

    func testExactCGIdentityRejectsMovedResizedOrReusedRoots() {
        let record: [String: Any] = [kCGWindowNumber as String: NSNumber(value: 10),
            kCGWindowOwnerPID as String: NSNumber(value: 42), kCGWindowIsOnscreen as String: true,
            kCGWindowBounds as String: root.dictionaryRepresentation]
        XCTAssertEqual(verifiedScreenshotWindow(windowID: 10, pid: 42, bounds: root, windowInfo: [record]), true)
        XCTAssertNil(verifiedScreenshotWindow(windowID: 10, pid: 99, bounds: root, windowInfo: [record]))
        XCTAssertNil(verifiedScreenshotWindow(windowID: 10, pid: 42, bounds: root.offsetBy(dx: 4, dy: 0), windowInfo: [record]))
        XCTAssertNil(verifiedScreenshotWindow(windowID: 10, pid: 42, bounds: CGRect(x: 0, y: 32, width: 1400, height: 884), windowInfo: [record]))
        XCTAssertNil(verifiedScreenshotWindow(windowID: 10, pid: 42, bounds: root, windowInfo: [record, record]))
        var hidden = record
        hidden[kCGWindowIsOnscreen as String] = false
        XCTAssertEqual(verifiedScreenshotWindow(windowID: 10, pid: 42, bounds: root, windowInfo: [hidden]), false)
    }

    func testAssociationsAreBoundedAndDoNotUseTitleLayerOrOverlapHeuristics() {
        let related = Set(CGWindowID(100)...CGWindowID(199))
        let identities = [available[0]] + related.map { WindowScreenshotIdentity(id: $0, pid: 42, onScreen: true) }
        let actual = plan(available: identities, related: related)
        XCTAssertEqual(actual?.relatedWindowIDs.count, 64)
        XCTAssertEqual(actual?.relatedWindowIDs.first, 100)
        XCTAssertEqual(actual?.relatedWindowIDs.last, 163)
    }

    private func record(_ id: UInt32, pid: Int32 = 42, layer: Int = 0,
                        bounds: CGRect? = nil, onScreen: Bool = true, alpha: Double = 1) -> [String: Any] {
        [kCGWindowNumber as String: NSNumber(value: id), kCGWindowOwnerPID as String: NSNumber(value: pid),
         kCGWindowLayer as String: NSNumber(value: layer), kCGWindowIsOnscreen as String: NSNumber(value: onScreen),
         kCGWindowAlpha as String: NSNumber(value: alpha),
         kCGWindowBounds as String: (bounds ?? root).dictionaryRepresentation]
    }

    func testWPSNewPanelIsDiscoveredWithoutAnAXAssociation() throws {
        // Read-only CGWindow evidence from WPS on 2026-10-10: root layer 0,
        // New panel layer 24, same PID. No popup ID is supplied by the caller.
        let bounds = CGRect(x: 0, y: 32, width: 1512, height: 884)
        let panel = CGRect(x: 320, y: 145, width: 364, height: 634)
        let info = [record(900, pid: 99, layer: 101), record(1886, pid: 82868, layer: 24, bounds: panel),
                    record(901, pid: 99), record(1870, pid: 82868, bounds: bounds)]
        let actual = discoveredWindowScreenshotOverlays(windowID: 1870, pid: 82868, bounds: bounds, windowInfo: info)
        XCTAssertEqual(actual, [WindowScreenshotOverlay(windowID: 1886, bounds: panel)])
        let plan = try XCTUnwrap(windowScreenshotPlan(windowID: 1870, pid: 82868, bounds: bounds, onScreen: true,
            supportsChildren: true, displays: displays,
            available: [WindowScreenshotIdentity(id: 1870, pid: 82868, onScreen: true),
                        WindowScreenshotIdentity(id: 1886, pid: 82868, onScreen: true)],
            relatedWindowIDs: Set(actual.map(\.windowID)), fallbackScale: 2))
        XCTAssertEqual(plan.relatedWindowIDs, [1886])
        XCTAssertEqual(plan.sourceRect, bounds)
    }

    func testDiscoveryNeverIncludesAnotherNormalDocumentOrAnotherProcess() {
        let small = CGRect(x: 320, y: 145, width: 364, height: 634)
        for doc in [record(11, bounds: small), record(11, bounds: root.offsetBy(dx: 2000, dy: 0))] {
            let info = [record(12, layer: 24, bounds: small), doc, record(10)]
            XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root, windowInfo: info), [])
        }
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root,
            windowInfo: [record(11, pid: 99, layer: 24, bounds: small), record(10)]), [])
    }

    func testPopupTopologyIsRediscoveredOnOpenCloseMoveAndReopen() {
        let panel = CGRect(x: 320, y: 145, width: 364, height: 634)
        let opened = [record(11, layer: 24, bounds: panel), record(10)]
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root, windowInfo: opened).map(\.windowID), [11])
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root, windowInfo: [record(10)]), [])
        let moved = root.offsetBy(dx: -1200, dy: -60)
        let movedPanel = panel.offsetBy(dx: -1200, dy: -60)
        let reopened = [record(12, layer: 24, bounds: movedPanel), record(10, bounds: moved)]
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: moved, windowInfo: reopened),
                       [WindowScreenshotOverlay(windowID: 12, bounds: movedPanel)])
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root, windowInfo: reopened), [])
    }

    func testOnlyVisibleUniqueElevatedWindowsAboveRootCanSupplementCapture() {
        let panel = CGRect(x: 320, y: 145, width: 364, height: 634)
        let invalid: [[String: Any]] = [record(0, layer: 24, bounds: panel),
            record(11, layer: 26, bounds: panel), record(12, layer: 1000, bounds: panel),
            record(13, layer: 24, bounds: panel, onScreen: false), record(14, layer: 24, bounds: panel, alpha: 0),
            record(15, layer: 24, bounds: panel.offsetBy(dx: 2000, dy: 0)),
            record(16, layer: 24, bounds: CGRect(x: 0, y: 50, width: 0, height: 10)),
            record(17, layer: 24, bounds: panel), record(17, pid: 99, layer: 24, bounds: panel)]
        let info = invalid + [record(18, layer: 101, bounds: panel), record(19, layer: 3, bounds: panel),
                              record(10), record(20, layer: 24, bounds: panel)]
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root, windowInfo: info).map(\.windowID), [19, 18])
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root,
            windowInfo: info + [record(10)]), [])
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 99, bounds: root, windowInfo: info), [])
        XCTAssertEqual(discoveredWindowScreenshotOverlays(windowID: 10, pid: 42, bounds: root,
            windowInfo: [record(11, layer: 24, bounds: panel), record(10, onScreen: false)]), [])
    }

    func testKnownVisiblePopupCannotBeSilentlyDroppedFromTheShareableGroup() {
        for identities in [[available[0]], [available[0], available[2]], [available[0], available[3]],
                           [available[0], available[1], available[1]]] {
            XCTAssertNil(windowScreenshotPlan(windowID: 10, pid: 42, bounds: root, onScreen: true,
                supportsChildren: true, displays: displays, available: identities,
                relatedWindowIDs: [11], requiredWindowIDs: [11], fallbackScale: 2))
        }
        XCTAssertEqual(windowScreenshotPlan(windowID: 10, pid: 42, bounds: root, onScreen: true,
            supportsChildren: true, displays: displays, available: available,
            relatedWindowIDs: [11], requiredWindowIDs: [11], fallbackScale: 2)?.relatedWindowIDs, [11])
    }
}
