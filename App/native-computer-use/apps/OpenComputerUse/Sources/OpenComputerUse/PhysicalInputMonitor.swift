import CoreGraphics
import Foundation

/// A read-only event tap. If macOS will not deliver input events to the signed
/// helper, locked use stays disabled rather than guessing that the user is idle.
final class PhysicalInputMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private let onInput: @Sendable () -> Void
    private let trustedSyntheticPID: pid_t
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var active = false

    init(trustedSyntheticPID: pid_t = getpid(), onInput: @escaping @Sendable () -> Void) {
        self.trustedSyntheticPID = trustedSyntheticPID
        self.onInput = onInput
    }

    var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return active && tap.map { CGEvent.tapIsEnabled(tap: $0) } == true
    }

    func start() {
        let mask = [CGEventType.keyDown, .keyUp, .flagsChanged,
                    .leftMouseDown, .rightMouseDown, .otherMouseDown,
                    .mouseMoved, .leftMouseDragged, .rightMouseDragged,
                    .scrollWheel].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        Thread.detachNewThread { [self] in
            let pointer = Unmanaged.passUnretained(self).toOpaque()
            guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                              place: .headInsertEventTap,
                                              options: .listenOnly,
                                              eventsOfInterest: mask,
                                              callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<PhysicalInputMonitor>.fromOpaque(context).takeUnretainedValue()
                monitor.observe(type: type, event: event)
                return Unmanaged.passUnretained(event)
            }, userInfo: pointer),
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
                onInput()
                return
            }
            let loop = CFRunLoopGetCurrent()
            lock.lock()
            self.tap = tap
            self.runLoop = loop
            self.active = true
            lock.unlock()
            CFRunLoopAddSource(loop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            CFRunLoopRun()
            lock.lock()
            self.active = false
            self.tap = nil
            self.runLoop = nil
            lock.unlock()
        }
    }

    func stop() {
        lock.lock()
        let loop = runLoop
        active = false
        lock.unlock()
        if let loop { CFRunLoopStop(loop) }
    }

    private func observe(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            active = false
            lock.unlock()
            onInput()
            return
        }
        let sourcePID = event.getIntegerValueField(.eventSourceUnixProcessID)
        if sourcePID != Int64(getpid()) && sourcePID != Int64(trustedSyntheticPID) { onInput() }
    }
}
