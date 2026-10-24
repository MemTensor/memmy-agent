import CoreGraphics
import Foundation
import ImageIO

enum CoordinateObservationIntent {
    case click(CGPoint)
    case drag(CGPoint, CGPoint)

    var patchCenters: [CGPoint] {
        switch self {
        case .click(let point): return [point]
        case .drag(let start, let end):
            // Adjacent 65-pixel patches cover a path at 64-pixel spacing.
            // Limit the sample count for larger images rather than assuming
            // a particular screenshot resolution.
            let distance = max(abs(end.x - start.x), abs(end.y - start.y))
            guard distance.isFinite else { return [start, end] }
            let intervals = max(1, Int(min(64, ceil(distance / 64))))
            return (0...intervals).map { index in
                let fraction = CGFloat(index) / CGFloat(intervals)
                return CGPoint(x: start.x + (end.x - start.x) * fraction,
                               y: start.y + (end.y - start.y) * fraction)
            }
        }
    }

    func isNear(_ other: CoordinateObservationIntent, tolerance: CGFloat = 16) -> Bool {
        func near(_ a: CGPoint, _ b: CGPoint) -> Bool { abs(a.x - b.x) <= tolerance && abs(a.y - b.y) <= tolerance }
        switch (self, other) {
        case (.click(let a), .click(let b)): return near(a, b)
        case (.drag(let a1, let a2), .drag(let b1, let b2)): return near(a1, b1) && near(a2, b2)
        default: return false
        }
    }
}

struct ScreenshotPixels {
    let width: Int
    let height: Int
    let rgba: [UInt8]

    static func decode(_ data: Data?) -> ScreenshotPixels? {
        guard let data, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width > 0, image.height > 0, image.width <= 4096, image.height <= 4096,
              image.width * image.height <= 4_000_000 else { return nil }
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let rendered = bytes.withUnsafeMutableBytes { storage -> Bool in
            guard let context = CGContext(data: storage.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        return rendered ? ScreenshotPixels(width: image.width, height: image.height, rgba: bytes) : nil
    }
}

enum ScreenshotRegionValidation: Equatable {
    case unchanged
    case changed
    case imageUnavailable
    case dimensionsChanged
    case invalidCoordinates
}

// A target is stale only when something replaced the content around it, such
// as a popup, dialog or scrolled view. A blinking caret, hover tint or
// antialiasing difference must not block the input.
private let patchRadius = 32
private let corePatchRadius = 4
private let changedPixelDelta = 48
private let changedPatchFraction = 0.25
private let changedCoreFraction = 0.5

func validateScreenshotRegions(
    observed: ScreenshotPixels?, fresh: ScreenshotPixels?, intent: CoordinateObservationIntent
) -> ScreenshotRegionValidation {
    guard let observed, let fresh,
          observed.width > 0, observed.height > 0, fresh.width > 0, fresh.height > 0,
          observed.width <= 4096, observed.height <= 4096, fresh.width <= 4096, fresh.height <= 4096,
          observed.rgba.count == observed.width * observed.height * 4,
          fresh.rgba.count == fresh.width * fresh.height * 4 else { return .imageUnavailable }
    guard observed.width == fresh.width, observed.height == fresh.height else { return .dimensionsChanged }
    func changedFraction(centerX: Int, centerY: Int, radius: Int) -> Double {
        var changed = 0, total = 0
        for y in max(0, centerY - radius)..<min(observed.height, centerY + radius + 1) {
            for x in max(0, centerX - radius)..<min(observed.width, centerX + radius + 1) {
                let offset = (y * observed.width + x) * 4
                total += 1
                if (0..<4).contains(where: {
                    abs(Int(observed.rgba[offset + $0]) - Int(fresh.rgba[offset + $0])) > changedPixelDelta
                }) { changed += 1 }
            }
        }
        return total == 0 ? 0 : Double(changed) / Double(total)
    }
    for point in intent.patchCenters {
        guard point.x.isFinite, point.y.isFinite, point.x >= 0, point.y >= 0,
              point.x < CGFloat(observed.width), point.y < CGFloat(observed.height) else { return .invalidCoordinates }
        let centerX = Int(point.x.rounded(.down)), centerY = Int(point.y.rounded(.down))
        if changedFraction(centerX: centerX, centerY: centerY, radius: patchRadius) > changedPatchFraction
            || changedFraction(centerX: centerX, centerY: centerY, radius: corePatchRadius) > changedCoreFraction {
            return .changed
        }
    }
    return .unchanged
}
