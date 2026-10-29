import AppKit
import CoreGraphics
import Foundation

/** Read-only window geometry for Memmy's permission accessory. No AX tree or
 * screen pixels are requested while the user is granting those permissions.
 */
enum SystemSettingsWindowWatch {
    private struct Frame: Equatable {
        let x: Int
        let y: Int
        let width: Int
        let height: Int

        var json: String { "{\"x\":\(x),\"y\":\(y),\"width\":\(width),\"height\":\(height)}" }

        init(_ rect: CGRect) {
            x = Int(rect.minX.rounded())
            y = Int(rect.minY.rounded())
            width = Int(rect.width.rounded())
            height = Int(rect.height.rounded())
        }
    }

    static func run(watch: Bool) {
        var previous: Frame?
        var emitted = false
        repeat {
            let current = visibleWindow()
            if !emitted || current != previous {
                let line = (current?.json ?? "null") + "\n"
                FileHandle.standardOutput.write(Data(line.utf8))
                previous = current
                emitted = true
            }
            if watch { Thread.sleep(forTimeInterval: 0.12) }
        } while watch
    }

    private static func visibleWindow() -> Frame? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences")
            .map(\.processIdentifier))
        guard !pids.isEmpty,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return nil }

        // The privacy list is the largest normal Settings window. Sheets and
        // transient overlays must not pull the accessory away from that list.
        let candidates = windows.compactMap { info -> CGRect? in
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let dictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dictionary),
                  bounds.width >= 500, bounds.height >= 400,
                  bounds.origin.x.isFinite, bounds.origin.y.isFinite,
                  bounds.width.isFinite, bounds.height.isFinite else { return nil }
            return bounds
        }
        guard let largest = candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) else { return nil }
        return Frame(largest)
    }
}
