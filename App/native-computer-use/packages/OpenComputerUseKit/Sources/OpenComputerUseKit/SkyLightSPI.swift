import AppKit
import CoreGraphics
import Darwin
import Foundation

struct SkyLightActivationCommand: Equatable {
    let psn: [UInt8]
    let windowID: CGWindowID
    let focused: Bool
}

struct SkyLightSyntheticFocusContext {
    let deactivateTarget: SkyLightActivationCommand
}

struct SkyLightSyntheticFocusPlan: Equatable {
    let activateTarget: SkyLightActivationCommand
    let deactivateTarget: SkyLightActivationCommand
}

func skyLightSyntheticTargetFocusPlan(
    targetPSN: [UInt8],
    targetWindowID: CGWindowID
) -> SkyLightSyntheticFocusPlan {
    SkyLightSyntheticFocusPlan(
        activateTarget: SkyLightActivationCommand(
            psn: targetPSN,
            windowID: targetWindowID,
            focused: true
        ),
        deactivateTarget: SkyLightActivationCommand(
            psn: targetPSN,
            windowID: targetWindowID,
            focused: false
        )
    )
}

/// Synthetic key focus of one window for keyboard input to a background app.
struct SyntheticWindowFocus {
    var frontmostPID: () -> pid_t?
    /// Returns the release, or nil when the window could not be focused.
    var begin: (pid_t, CGWindowID) -> (() -> Void)?

    /// Posted keys reach the app asynchronously, so the release waits for them.
    static let keyboardReleaseDelay: TimeInterval = 0.2

    static var live: SyntheticWindowFocus {
        SyntheticWindowFocus(
            frontmostPID: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
            begin: { pid, windowID in
                let spi = SkyLightSPI.shared
                guard let context = try? spi.beginSyntheticTargetFocus(targetPID: pid, targetWindowID: windowID) else {
                    return nil
                }
                return {
                    Thread.sleep(forTimeInterval: keyboardReleaseDelay)
                    try? spi.endSyntheticTargetFocus(context)
                }
            }
        )
    }
}

func skyLightActivationRecord(windowID: CGWindowID, focused: Bool) -> [UInt8] {
    var record = [UInt8](repeating: 0, count: 0xF8)
    record[0x04] = 0xF8
    record[0x08] = 0x0D
    record[0x3C] = UInt8(truncatingIfNeeded: windowID)
    record[0x3D] = UInt8(truncatingIfNeeded: windowID >> 8)
    record[0x3E] = UInt8(truncatingIfNeeded: windowID >> 16)
    record[0x3F] = UInt8(truncatingIfNeeded: windowID >> 24)
    record[0x8A] = focused ? 0x01 : 0x02
    return record
}

struct SkyLightSPICapability: Equatable, Sendable {
    let missingSymbols: [String]

    var isAvailable: Bool {
        missingSymbols.isEmpty
    }

    var unavailableReason: String {
        if missingSymbols.isEmpty {
            return "available"
        }

        return "missing private click symbols: \(missingSymbols.joined(separator: ", "))"
    }
}

/// Runtime-only bridge for the private SkyLight functions used by `sky_click`.
///
/// The declarations and event-field recipe are derived from the MIT-licensed
/// Cua Driver and yabai implementations. Keep all undocumented ABI in this
/// file so a future macOS compatibility change has one review boundary.
final class SkyLightSPI: @unchecked Sendable {
    static let shared = SkyLightSPI()

    private static let frameworkPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    private static let postToPidSymbol = "SLEventPostToPid"
    private static let setIntegerFieldSymbol = "SLEventSetIntegerValueField"
    private static let setWindowLocationSymbol = "CGEventSetWindowLocation"
    private static let postEventRecordSymbol = "SLPSPostEventRecordTo"
    private static let setFrontProcessSymbol = "_SLPSSetFrontProcessWithOptions"
    private static let getProcessForPIDSymbol = "GetProcessForPID"
    private static let applicationServicesPath = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    // kCPSUserGenerated and kCPSNoWindows.
    private static let frontProcessUserGenerated: UInt32 = 0x200
    private static let frontProcessNoWindows: UInt32 = 0x400

    private typealias PostToPidFunction = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
    private typealias SetIntegerFieldFunction = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
    // Cua's current Rust bridge models this private ABI as
    // (CGEventRef, double x, double y). Keeping the scalar form here avoids
    // relying on Swift's aggregate CGPoint calling convention.
    private typealias SetWindowLocationFunction = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
    private typealias PostEventRecordFunction = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
    private typealias SetFrontProcessFunction = @convention(c) (UnsafeRawPointer?, UInt32, UInt32) -> Int32
    private typealias GetProcessForPIDFunction = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32

    private let frameworkHandle: UnsafeMutableRawPointer?
    private let applicationServicesHandle: UnsafeMutableRawPointer?
    private let postToPidFunction: PostToPidFunction?
    private let setIntegerFieldFunction: SetIntegerFieldFunction?
    private let setWindowLocationFunction: SetWindowLocationFunction?
    private let postEventRecordFunction: PostEventRecordFunction?
    private let setFrontProcessFunction: SetFrontProcessFunction?
    private let getProcessForPIDFunction: GetProcessForPIDFunction?

    let capability: SkyLightSPICapability

    /// Foreground activation is optional: background clicks never need it.
    var canSetFrontProcess: Bool {
        setFrontProcessFunction != nil && getProcessForPIDFunction != nil
    }

    private init() {
        let handle = dlopen(Self.frameworkPath, RTLD_LAZY | RTLD_GLOBAL)
        let appServicesHandle = dlopen(Self.applicationServicesPath, RTLD_LAZY | RTLD_GLOBAL)
        frameworkHandle = handle
        applicationServicesHandle = appServicesHandle
        postToPidFunction = Self.resolve(handle: handle, symbol: Self.postToPidSymbol)
        setIntegerFieldFunction = Self.resolve(handle: handle, symbol: Self.setIntegerFieldSymbol)
        setWindowLocationFunction = Self.resolve(handle: handle, symbol: Self.setWindowLocationSymbol)
        postEventRecordFunction = Self.resolve(handle: handle, symbol: Self.postEventRecordSymbol)
        setFrontProcessFunction = Self.resolve(handle: handle, symbol: Self.setFrontProcessSymbol)
        getProcessForPIDFunction = Self.resolve(handle: appServicesHandle, symbol: Self.getProcessForPIDSymbol)

        var missingSymbols: [String] = []
        if postToPidFunction == nil {
            missingSymbols.append(Self.postToPidSymbol)
        }
        if setIntegerFieldFunction == nil {
            missingSymbols.append(Self.setIntegerFieldSymbol)
        }
        if setWindowLocationFunction == nil {
            missingSymbols.append(Self.setWindowLocationSymbol)
        }
        if postEventRecordFunction == nil {
            missingSymbols.append(Self.postEventRecordSymbol)
        }
        if getProcessForPIDFunction == nil {
            missingSymbols.append(Self.getProcessForPIDSymbol)
        }
        capability = SkyLightSPICapability(missingSymbols: missingSymbols)
    }

    func postToPid(_ event: CGEvent, pid: pid_t) throws {
        guard let postToPidFunction else {
            throw unavailableError()
        }

        postToPidFunction(pid, opaquePointer(for: event))
    }

    func setIntegerField(_ event: CGEvent, field: UInt32, value: Int64) throws {
        guard let setIntegerFieldFunction else {
            throw unavailableError()
        }

        setIntegerFieldFunction(opaquePointer(for: event), field, value)
    }

    func setWindowLocation(_ event: CGEvent, point: CGPoint) throws {
        guard let setWindowLocationFunction else {
            throw unavailableError()
        }

        setWindowLocationFunction(opaquePointer(for: event), point.x, point.y)
    }

    func beginSyntheticTargetFocus(
        targetPID: pid_t,
        targetWindowID: CGWindowID
    ) throws -> SkyLightSyntheticFocusContext {
        let targetPSN = try processSerialNumber(for: targetPID)
        let plan = skyLightSyntheticTargetFocusPlan(
            targetPSN: targetPSN,
            targetWindowID: targetWindowID
        )
        try postActivationCommand(plan.activateTarget)
        Thread.sleep(forTimeInterval: 0.040)

        return SkyLightSyntheticFocusContext(
            deactivateTarget: plan.deactivateTarget
        )
    }

    func endSyntheticTargetFocus(_ context: SkyLightSyntheticFocusContext) throws {
        try postActivationCommand(context.deactivateTarget)
        Thread.sleep(forTimeInterval: 0.040)
    }

    /// A real activation: unlike synthetic focus, the system frontmost app
    /// changes, so the caller must hand it back. macOS 14 may decline
    /// NSRunningApplication activation requested by a background helper.
    func setFrontProcess(pid: pid_t, windowID: CGWindowID?) throws {
        guard let setFrontProcessFunction else {
            throw ComputerUseError.message("Foreground activation is unavailable: missing \(Self.setFrontProcessSymbol)")
        }

        let psn = try processSerialNumber(for: pid)
        let options = windowID == nil ? Self.frontProcessNoWindows : Self.frontProcessUserGenerated
        let status = psn.withUnsafeBytes { bytes in
            setFrontProcessFunction(bytes.baseAddress, windowID ?? 0, options)
        }
        guard status == 0 else {
            throw ComputerUseError.message("Foreground activation of PID \(pid) failed (CGError \(status))")
        }
    }

    private func processSerialNumber(for pid: pid_t) throws -> [UInt8] {
        guard let getProcessForPIDFunction else {
            throw unavailableError()
        }

        var psn = [UInt8](repeating: 0, count: 8)
        let status = psn.withUnsafeMutableBytes { bytes in
            getProcessForPIDFunction(pid, bytes.baseAddress)
        }
        guard status == 0 else {
            throw ComputerUseError.message(
                "click_method 'sky_click' could not resolve target PID \(pid) to a PSN (OSStatus \(status))"
            )
        }
        return psn
    }

    private func unavailableError() -> ComputerUseError {
        ComputerUseError.message(
            "click_method 'sky_click' is unavailable: \(capability.unavailableReason)"
        )
    }

    private func opaquePointer(for event: CGEvent) -> UnsafeMutableRawPointer {
        Unmanaged.passUnretained(event).toOpaque()
    }

    private func postActivationCommand(_ command: SkyLightActivationCommand) throws {
        guard let postEventRecordFunction else {
            throw unavailableError()
        }

        let record = skyLightActivationRecord(
            windowID: command.windowID,
            focused: command.focused
        )
        let status = command.psn.withUnsafeBytes { psnBytes in
            record.withUnsafeBufferPointer { recordBytes in
                postEventRecordFunction(psnBytes.baseAddress, recordBytes.baseAddress)
            }
        }
        guard status == 0 else {
            throw ComputerUseError.message(
                "click_method 'sky_click' synthetic target-focus event failed (OSStatus \(status))"
            )
        }
    }

    private static func resolve<T>(handle: UnsafeMutableRawPointer?, symbol: String) -> T? {
        guard let handle, let pointer = dlsym(handle, symbol) else {
            return nil
        }

        return unsafeBitCast(pointer, to: T.self)
    }
}
