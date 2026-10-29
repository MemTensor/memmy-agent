import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import MemmyComputerUseKit

func regionSafetyTestPNG(width: Int = 128, height: Int = 128, changedPixels: [CGPoint] = [],
                         changedRects: [CGRect] = []) throws -> Data {
    var rgba = [UInt8](repeating: 255, count: width * height * 4)
    func change(_ x: Int, _ y: Int) {
        guard x >= 0, y >= 0, x < width, y < height else { return }
        let offset = (y * width + x) * 4
        rgba[offset + 1] = 0
        rgba[offset + 2] = 0
    }
    for point in changedPixels { change(Int(point.x), Int(point.y)) }
    for rect in changedRects {
        for y in Int(rect.minY)..<Int(rect.maxY) { for x in Int(rect.minX)..<Int(rect.maxX) { change(x, y) } }
    }
    let provider = try XCTUnwrap(CGDataProvider(data: Data(rgba) as CFData))
    let image = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8,
        bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
}

final class ScreenshotRegionSafetyTests: XCTestCase {
    private func pixels(changed rects: [CGRect] = [], delta: UInt8 = 255, width: Int = 128,
                        height: Int = 128) -> ScreenshotPixels {
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for rect in rects {
            for y in max(0, Int(rect.minY))..<min(height, Int(rect.maxY)) {
                for x in max(0, Int(rect.minX))..<min(width, Int(rect.maxX)) {
                    bytes[(y * width + x) * 4] = 255 - delta
                }
            }
        }
        return ScreenshotPixels(width: width, height: height, rgba: bytes)
    }

    func testCaretHoverTintAndAntialiasingAtTheTargetDoNotBlockTheInput() {
        let target = CoordinateObservationIntent.click(CGPoint(x: 40, y: 40))
        let caret = CGRect(x: 41, y: 30, width: 2, height: 20)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [caret]), intent: target), .unchanged)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [CGRect(x: 40, y: 40, width: 1, height: 1)]),
            intent: target), .unchanged)
        let hover = CGRect(x: 8, y: 8, width: 64, height: 64)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [hover], delta: 30), intent: target), .unchanged)
    }

    func testContentCoveringTheTargetOrItsExactPointIsRejected() {
        let target = CoordinateObservationIntent.click(CGPoint(x: 40, y: 40))
        let popup = CGRect(x: 30, y: 20, width: 60, height: 60)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [popup]), intent: target), .changed)
        let pointCover = CGRect(x: 36, y: 36, width: 9, height: 9)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [pointCover]), intent: target), .changed)
    }

    func testOtherPartsOfScreenshotCanAnimateWithoutBlockingCoordinateTarget() {
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [CGRect(x: 90, y: 90, width: 38, height: 38)]),
            intent: .click(CGPoint(x: 20, y: 20))), .unchanged)
    }

    func testDragChecksEndpointsAndIntermediatePathPatches() {
        let drag = CoordinateObservationIntent.drag(CGPoint(x: 10, y: 10), CGPoint(x: 110, y: 110))
        for point in [CGPoint(x: 10, y: 10), CGPoint(x: 60, y: 60), CGPoint(x: 110, y: 110)] {
            let cover = CGRect(x: point.x - 6, y: point.y - 6, width: 12, height: 12)
            XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [cover]), intent: drag), .changed)
        }
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [CGRect(x: 100, y: 0, width: 28, height: 20)]),
            intent: drag), .unchanged)
    }

    func testMissingResizedInvalidOrOutOfBoundsScreenshotsNeverAuthorizeOldCoordinates() {
        let intent = CoordinateObservationIntent.click(CGPoint(x: 20, y: 20))
        XCTAssertEqual(validateScreenshotRegions(observed: nil, fresh: pixels(), intent: intent), .imageUnavailable)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: nil, intent: intent), .imageUnavailable)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(width: 64, height: 64), intent: intent), .dimensionsChanged)
        XCTAssertEqual(validateScreenshotRegions(observed: ScreenshotPixels(width: 128, height: 128, rgba: []),
            fresh: pixels(), intent: intent), .imageUnavailable)
        for point in [CGPoint(x: -1, y: 20), CGPoint(x: 128, y: 20), CGPoint(x: CGFloat.nan, y: 20),
                      CGPoint(x: CGFloat.infinity, y: 20), CGPoint(x: 1e100, y: 20)] {
            XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(), intent: .click(point)), .invalidCoordinates)
        }
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(),
            intent: .drag(CGPoint(x: 0, y: 0), CGPoint(x: 1e100, y: 1e100))), .invalidCoordinates)
    }

    func testTargetPatchClipsAtImageEdge() {
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(changed: [CGRect(x: 0, y: 0, width: 5, height: 5)]),
            intent: .click(.zero)), .changed)
        XCTAssertEqual(validateScreenshotRegions(observed: pixels(), fresh: pixels(), intent: .click(.zero)), .unchanged)
    }

    func testPNGDecodingKeepsScreenshotPixelCoordinatesAndComparesOnlyTargetRegion() throws {
        let base = try XCTUnwrap(ScreenshotPixels.decode(regionSafetyTestPNG()))
        let inside = try XCTUnwrap(ScreenshotPixels.decode(regionSafetyTestPNG(changedRects: [CGRect(x: 14, y: 14, width: 12, height: 12)])))
        let outside = try XCTUnwrap(ScreenshotPixels.decode(regionSafetyTestPNG(changedRects: [CGRect(x: 100, y: 100, width: 28, height: 28)])))
        let offset = (20 * 128 + 20) * 4
        XCTAssertEqual(Array(inside.rgba[offset..<offset + 4]), [255, 0, 0, 255])
        XCTAssertEqual(validateScreenshotRegions(observed: base, fresh: inside, intent: .click(CGPoint(x: 20, y: 20))), .changed)
        XCTAssertEqual(validateScreenshotRegions(observed: base, fresh: inside,
            intent: .click(CGPoint(x: 20, y: 128 - 1 - 20))), .unchanged,
            "A top-row block must not be mistaken for its bottom-row mirror")
        XCTAssertEqual(validateScreenshotRegions(observed: base, fresh: outside, intent: .click(CGPoint(x: 20, y: 20))), .unchanged)
    }

    func testRetryProximityMatchesOnlyTheSameKindOfNearbyTarget() {
        let click = CoordinateObservationIntent.click(CGPoint(x: 100, y: 100))
        XCTAssertTrue(click.isNear(.click(CGPoint(x: 110, y: 92))))
        XCTAssertFalse(click.isNear(.click(CGPoint(x: 130, y: 100))))
        XCTAssertFalse(click.isNear(.drag(CGPoint(x: 100, y: 100), CGPoint(x: 100, y: 100))))
        let drag = CoordinateObservationIntent.drag(CGPoint(x: 10, y: 10), CGPoint(x: 90, y: 90))
        XCTAssertTrue(drag.isNear(.drag(CGPoint(x: 12, y: 8), CGPoint(x: 95, y: 90))))
        XCTAssertFalse(drag.isNear(.drag(CGPoint(x: 12, y: 8), CGPoint(x: 150, y: 90))))
    }
}
