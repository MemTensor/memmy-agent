import Foundation

private final class CaptureFixture: ScreenObservationProvider {
    var available: [ScreenObservationDisplay]
    var calls: [String] = []
    var failure: Error?
    var imageOverride: ScreenObservationImage?

    init(_ available: [ScreenObservationDisplay]) { self.available = available }

    func displays() throws -> [ScreenObservationDisplay] {
        calls.append("displays")
        return available
    }

    func capture(display: ScreenObservationDisplay, width: Int, height: Int) throws -> ScreenObservationImage {
        calls.append("capture:\(display.id):\(width)x\(height)")
        if let failure { throw failure }
        return imageOverride ?? ScreenObservationImage(pngData: Data([137, 80, 78, 71]), width: width, height: height)
    }
}

@main enum ScreenObservationTests {
    static func main() throws {
        let secondary = ScreenObservationDisplay(id: 2, width: 1000, height: 1600, originX: -1000, originY: 0, isMain: false)
        let main = ScreenObservationDisplay(id: 7, width: 3840, height: 2160, originX: 0, originY: 0, isMain: true)

        let defaultCapture = CaptureFixture([secondary, main])
        let result = try observeCurrentScreen(provider: defaultCapture)
        precondition(result.display.id == 7, "Default observation must capture the main screen, not Finder or the first catalog entry")
        precondition(defaultCapture.calls == ["displays", "capture:7:1600x900"], "Default path should enumerate once and capture one bounded display")
        precondition(result.availableDisplays.map(\.id) == [2, 7], "Other displays must be discoverable without capturing them")

        let explicitCapture = CaptureFixture([main, secondary])
        let explicitResult = try observeCurrentScreen(displayID: 2, provider: explicitCapture)
        precondition(explicitResult.display.id == 2)
        precondition(explicitCapture.calls == ["displays", "capture:2:1000x1600"], "Explicit display observation must not upscale or capture other displays")

        let unknownDisplay = CaptureFixture([main])
        do {
            _ = try observeCurrentScreen(displayID: 999, provider: unknownDisplay)
            preconditionFailure("Unknown displays must fail instead of capturing a different screen")
        } catch {}
        precondition(unknownDisplay.calls == ["displays"])

        let disconnected = CaptureFixture([])
        do {
            _ = try observeCurrentScreen(provider: disconnected)
            preconditionFailure("No display must fail without launching an application to obtain a window")
        } catch {}
        precondition(disconnected.calls == ["displays"])

        let captureFailure = CaptureFixture([main, secondary])
        captureFailure.failure = ScreenObservationFailure(message: "capture unavailable")
        do {
            _ = try observeCurrentScreen(provider: captureFailure)
            preconditionFailure("Failed capture must not fall back to another display or app")
        } catch {
            precondition(error.localizedDescription == "capture unavailable")
        }
        precondition(captureFailure.calls == ["displays", "capture:7:1600x900"])

        let oversize = CaptureFixture([main])
        oversize.imageOverride = ScreenObservationImage(pngData: Data(count: 900_001), width: 1600, height: 900)
        do {
            _ = try observeCurrentScreen(provider: oversize)
            preconditionFailure("Oversize images must not enter the model payload")
        } catch {}

        let invalid = CaptureFixture([ScreenObservationDisplay(id: 1, width: 0, height: 1000, originX: 0, originY: 0, isMain: true)])
        do {
            _ = try observeCurrentScreen(provider: invalid)
            preconditionFailure("Zero-sized displays must not be captured")
        } catch {}
        precondition(invalid.calls == ["displays"])

        let noMain = CaptureFixture([main, secondary].map { display in
            ScreenObservationDisplay(id: display.id, width: display.width, height: display.height,
                originX: display.originX, originY: display.originY, isMain: false)
        })
        let noMainResult = try observeCurrentScreen(provider: noMain)
        precondition(noMainResult.display.id == 2, "A missing main-display marker must select a stable available display")
        print("8 passive screen observation checks passed")
    }
}
