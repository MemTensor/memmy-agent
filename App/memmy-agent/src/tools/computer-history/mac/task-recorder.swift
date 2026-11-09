// Task-scoped, local-only video. Computer History never runs this helper.
// One listen-only input tap and one window-only ScreenCaptureKit stream.
import AppKit
import ApplicationServices
import AVFoundation
import Carbon.HIToolbox
import CoreGraphics
import CoreImage
import CryptoKit
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit

let canvasWidth = 1920
let canvasHeight = 1080
let nativeTimescale: Int32 = 1_000_000_000
let nativeFrequency: UInt64 = 1_000_000_000
// MP4 sample durations are 32-bit track ticks: nanoseconds overflow for a
// held frame longer than ~4.29 s. Keep the evidence clock in nanoseconds and
// rescale only the encoded/remuxed track (one tick is less than 17 microseconds).
let videoTimescale: Int32 = 60_000
let frameInterval: UInt64 = 66_666_667
let maximumDuration: UInt64 = 1_200_000_000_000
let jsonNull = NSNull()

struct TaskFailure: Error { let code: String; init(_ code: String) { self.code = code } }
func require(_ condition: @autoclosure () -> Bool, _ code: String) throws {
  if !condition() { throw TaskFailure(code) }
}
func hostTicks() -> UInt64 {
  UInt64(CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), timescale: nativeTimescale, method: .default).value)
}
func hostNanoseconds(_ time: CMTime) -> UInt64? {
  guard time.isValid, time.isNumeric, time.value >= 0 else { return nil }
  let value = CMTimeConvertScale(time, timescale: nativeTimescale, method: .default).value
  return value >= 0 ? UInt64(value) : nil
}
func hostNanosecondsFromMach(_ value: UInt64) -> UInt64? { hostNanoseconds(CMClockMakeHostTimeFromSystemUnits(value)) }
func mediaTime(_ value: UInt64) -> CMTime { CMTime(value: Int64(value), timescale: nativeTimescale) }
func elapsedMs(_ ticks: UInt64, _ origin: UInt64) -> Double { Double(ticks >= origin ? ticks - origin : 0) / 1_000_000 }
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func fileHash(_ url: URL) throws -> String {
  try regularFile(url)
  let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
  var hash = SHA256()
  while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
  return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func regularFile(_ url: URL, maximum: UInt64 = UInt64.max) throws {
  let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
  try require(values.isRegularFile == true && values.isSymbolicLink != true && UInt64(values.fileSize ?? 0) <= maximum, "invalid_file")
}
func syncFile(_ url: URL) throws {
  let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
  try require(fd >= 0, "sync_open_failed"); defer { Darwin.close(fd) }
  try require(fsync(fd) == 0, "sync_failed")
}
func atomicJSON(_ url: URL, _ value: Any) throws {
  try jsonData(value).write(to: url, options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  try syncFile(url)
}
func readJSON(_ url: URL) throws -> [String: Any] {
  try regularFile(url, maximum: 4 * 1024 * 1024)
  guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw TaskFailure("invalid_json") }
  return value
}
func outputJSON(_ value: Any) {
  guard let data = try? jsonData(value) else { return }
  FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func processStart(_ app: NSRunningApplication) -> String? {
  guard let date = app.launchDate else { return nil }
  return String(UInt64((date.timeIntervalSince1970 * 1_000_000).rounded()))
}
func runningApplications() -> [[String: Any]] {
  NSWorkspace.shared.runningApplications.compactMap { app in
    guard app.activationPolicy == .regular, !app.isTerminated, let bundleId = app.bundleIdentifier,
          let executable = app.executableURL?.path, let start = processStart(app) else { return nil }
    return ["bundleId": bundleId, "name": app.localizedName ?? bundleId, "pid": Int(app.processIdentifier), "processStart": start, "executable": executable]
  }
}
func permissions(_ request: String? = nil) -> [String: Bool] {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: request == "accessibility"] as CFDictionary
  return ["accessibility": AXIsProcessTrustedWithOptions(options),
    "inputMonitoring": request == "inputMonitoring" ? CGRequestListenEventAccess() : CGPreflightListenEventAccess(),
    "screenRecording": request == "screenRecording" ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()]
}
let deniedBundles: Set<String> = [
  "com.apple.loginwindow", "com.apple.ScreenSaver.Engine", "com.apple.systempreferences", "com.apple.controlcenter",
  "com.apple.notificationcenterui", "com.apple.SecurityAgent", "com.google.Chrome", "com.google.Chrome.canary",
  "com.apple.Safari", "com.apple.SafariTechnologyPreview", "company.thebrowser.Browser", "com.microsoft.edgemac",
  "com.brave.Browser", "org.mozilla.firefox", "org.chromium.Chromium", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
  "com.microsoft.rdc.macos", "com.microsoft.rdc.mac", "com.microsoft.WindowsApp"
]
func supportedBundle(_ bundleId: String) -> Bool {
  !deniedBundles.contains(where: { bundleId == $0 || bundleId.hasPrefix($0 + ".") })
    && bundleId.range(of: "remote.?desktop|teamviewer|anydesk|citrix|vmware|parallels", options: [.regularExpression, .caseInsensitive]) == nil
}
struct TaskPolicy {
  let applications: [[String: Any]]
  let parentPid: pid_t
  let digest: String
  init(_ directory: URL) throws {
    let file = directory.appendingPathComponent("policy.json")
    let value = try readJSON(file)
    guard value["version"] as? Int == 1, value["maxDurationMs"] as? Int == 1_200_000,
          let parent = value["parentPid"] as? Int, parent > 0,
          let apps = value["applications"] as? [[String: Any]], !apps.isEmpty, apps.count <= 32 else { throw TaskFailure("invalid_policy") }
    try require(apps.allSatisfy { app in
      guard let bundle = app["bundleId"] as? String, let pid = app["pid"] as? Int, let start = app["processStart"] as? String,
            let exe = app["executable"] as? String else { return false }
      return supportedBundle(bundle) && pid > 0 && UInt64(start) != nil && exe.hasPrefix("/")
    }, "invalid_policy_application")
    applications = apps; parentPid = pid_t(parent); digest = try fileHash(file)
  }
  func allows(_ app: NSRunningApplication) -> Bool {
    guard let bundle = app.bundleIdentifier, supportedBundle(bundle), let start = processStart(app), let executable = app.executableURL?.path else { return false }
    return applications.contains { $0["bundleId"] as? String == bundle && $0["pid"] as? Int == Int(app.processIdentifier)
      && $0["processStart"] as? String == start && $0["executable"] as? String == executable }
  }
  func allowsWindow(_ window: [String: Any]) -> Bool {
    applications.contains { app in ["pid", "bundleId", "processStart", "executable"].allSatisfy { key in
      (app[key] as? NSObject)?.isEqual(window[key]) == true
    } }
  }
}
final class CaptureLease {
  private let fd: Int32
  init(_ directory: URL, wait: Bool = false) throws {
    fd = Darwin.open(directory.appendingPathComponent("capture.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    try require(fd >= 0, "capture_lock_failed")
    let deadline = hostTicks() + (wait ? 5_000_000_000 : 0)
    while flock(fd, LOCK_EX | LOCK_NB) != 0 {
      if hostTicks() >= deadline { Darwin.close(fd); throw TaskFailure("capture_still_active") }
      usleep(20_000)
    }
  }
  deinit { flock(fd, LOCK_UN); Darwin.close(fd) }
}
struct WindowIdentity {
  let pid: pid_t
  let id: CGWindowID
  let bundleId: String
  let executable: String
  let start: String
  let rect: CGRect
  let scale: Double
  var payload: [String: Any] { ["platform": "macos", "windowId": Int(id), "pid": Int(pid), "bundleId": bundleId,
    "executable": executable, "processStart": start, "scale": scale,
    "bounds": ["left": Double(rect.minX), "top": Double(rect.minY), "right": Double(rect.maxX), "bottom": Double(rect.maxY)]] }
  var key: String { "\(pid):\(id):\(start):\(rect):\(scale)" }
}
func frontWindow(_ policy: TaskPolicy) -> WindowIdentity? {
  guard let app = NSWorkspace.shared.frontmostApplication, policy.allows(app), !app.isHidden, !app.isTerminated,
        let bundle = app.bundleIdentifier, let executable = app.executableURL?.path, let start = processStart(app) else { return nil }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element, 0.05)
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
        let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
  let window = focused as! AXUIElement
  var position: CFTypeRef?, size: CFTypeRef?, minimized: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
        let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
  _ = AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized)
  if (minimized as? NSNumber)?.boolValue == true { return nil }
  var point = CGPoint.zero, dimensions = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
  let focusedRect = CGRect(origin: point, size: dimensions)
  guard focusedRect.width >= 1, focusedRect.height >= 1,
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  // Lock/login surfaces must not leave the previous application capturable.
  if windows.contains(where: { info in
    guard (info[kCGWindowAlpha as String] as? Double ?? 0) > 0, let pid = info[kCGWindowOwnerPID as String] as? Int else { return false }
    let bundle = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier
    return bundle == "com.apple.loginwindow" || bundle == "com.apple.ScreenSaver.Engine"
  }) { return nil }
  let matches = windows.filter { info in
    guard info[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier), info[kCGWindowLayer as String] as? Int == 0,
          (info[kCGWindowAlpha as String] as? Double ?? 0) >= 0.999,
          let bounds = info[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
    return abs(rect.minX - focusedRect.minX) <= 1 && abs(rect.minY - focusedRect.minY) <= 1
      && abs(rect.width - focusedRect.width) <= 1 && abs(rect.height - focusedRect.height) <= 1
  }
  guard matches.count == 1, let id = matches[0][kCGWindowNumber as String] as? UInt32 else { return nil }
  // Independent-window capture excludes separate child/menu windows. A
  // visible overlapping window above the focused surface is a gap, not an
  // assertion that the stream contains the menu the user is interacting with.
  if let focusedIndex = windows.firstIndex(where: { $0[kCGWindowNumber as String] as? UInt32 == id }),
     windows.prefix(focusedIndex).contains(where: { info in
       guard info[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier),
             (info[kCGWindowAlpha as String] as? Double ?? 0) > 0,
             let bounds = info[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
       return rect.intersects(focusedRect)
     }) { return nil }
  var display: CGDirectDisplayID = 0, count: UInt32 = 0
  guard CGGetDisplaysWithPoint(CGPoint(x: focusedRect.midX, y: focusedRect.midY), 1, &display, &count) == .success,
        count == 1, CGDisplayBounds(display).insetBy(dx: -1, dy: -1).contains(focusedRect) else { return nil }
  guard let screen = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display }) else { return nil }
  let scale = Double(screen.backingScaleFactor)
  guard scale >= 1, scale <= 4, NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return nil }
  return WindowIdentity(pid: app.processIdentifier, id: id, bundleId: bundle, executable: executable, start: start, rect: focusedRect, scale: scale)
}
func newCanvas() throws -> CVPixelBuffer {
  var buffer: CVPixelBuffer?
  let attributes = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true,
    kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
  try require(CVPixelBufferCreate(kCFAllocatorDefault, canvasWidth, canvasHeight, kCVPixelFormatType_32BGRA, attributes, &buffer) == kCVReturnSuccess, "pixel_buffer_failed")
  guard let buffer else { throw TaskFailure("pixel_buffer_failed") }
  try require(CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess, "pixel_buffer_lock_failed")
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { CVPixelBufferUnlockBaseAddress(buffer, []); throw TaskFailure("pixel_buffer_base_missing") }
  memset(base, 0, CVPixelBufferGetBytesPerRow(buffer) * canvasHeight)
  CVPixelBufferUnlockBaseAddress(buffer, [])
  return buffer
}
final class PartEncoder {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  let start: UInt64
  let index: Int
  let file: URL
  var frameCount = 0
  init(directory: URL, index: Int, start: UInt64) throws {
    self.start = start; self.index = index
    file = directory.appendingPathComponent(String(format: "%06d.mp4", index))
    writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: canvasWidth, AVVideoHeightKey: canvasHeight, AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 4_000_000, AVVideoExpectedSourceFrameRateKey: 15, AVVideoMaxKeyFrameIntervalKey: 15,
        AVVideoAllowFrameReorderingKey: false, AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel]])
    input.expectsMediaDataInRealTime = true; input.mediaTimeScale = videoTimescale
    try require(writer.canAdd(input), "encoder_input_failed"); writer.add(input)
    try require(writer.startWriting(), "encoder_start_failed"); writer.startSession(atSourceTime: .zero)
  }
  func append(_ buffer: CVPixelBuffer, at ticks: UInt64, duration: UInt64) throws {
    try require(ticks >= start && duration > 0, "encoder_timestamp_invalid")
    var format: CMVideoFormatDescription?
    try require(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format) == noErr, "encoder_format_failed")
    guard let format else { throw TaskFailure("encoder_format_failed") }
    var timing = CMSampleTimingInfo(duration: mediaTime(duration), presentationTimeStamp: mediaTime(ticks - start), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    try require(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, "encoder_sample_failed")
    guard let sample else { throw TaskFailure("encoder_sample_failed") }
    // Backpressure never silently drops a frame or its input evidence.
    let deadline = hostTicks() + 2 * nativeFrequency
    while !input.isReadyForMoreMediaData && writer.status == .writing && hostTicks() < deadline { usleep(1000) }
    try require(input.isReadyForMoreMediaData && input.append(sample), "encoder_backpressure")
    frameCount += 1
  }
  func finish(end: UInt64) throws {
    try require(end > start && frameCount > 0, "empty_part")
    writer.endSession(atSourceTime: mediaTime(end - start)); input.markAsFinished()
    let completed = DispatchSemaphore(value: 0)
    writer.finishWriting { completed.signal() }
    try require(completed.wait(timeout: .now() + 15) == .success, "part_finalize_timeout")
    try require(writer.status == .completed, "part_finalize_failed")
    try syncFile(file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }
}
struct PendingCanvas {
  let buffer: CVPixelBuffer
  let ticks: UInt64
  let window: WindowIdentity?
  let sourceTicks: UInt64?
  let repeated: Bool
  let gapReason: String?
}
final class VideoPackage {
  let directory: URL
  let origin: UInt64
  let clock: [String: String]
  private let partsDirectory: URL
  private let indexFile: FileHandle
  private var encoder: PartEncoder?
  private var pending: PendingCanvas?
  private var frameIndex = 0
  private var partIndex = 0
  private var frameHash = SHA256()
  private var firstFrame = 0
  private var lastCheckpoint: UInt64 = 0
  init(_ directory: URL, origin: UInt64) throws {
    self.directory = directory; self.origin = origin; clock = ["kind": "mach_host", "origin": String(origin), "frequency": String(nativeFrequency)]
    partsDirectory = directory.appendingPathComponent("parts")
    try FileManager.default.createDirectory(at: partsDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let file = directory.appendingPathComponent("frames.jsonl")
    let fd = Darwin.open(file.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
    try require(fd >= 0, "frame_index_create_failed"); indexFile = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    try checkpoint(origin)
  }
  deinit { try? indexFile.close() }
  private func checkpoint(_ at: UInt64) throws {
    try atomicJSON(directory.appendingPathComponent("capture-state.json"), ["clock": clock, "durationMs": elapsedMs(at, origin)])
    lastCheckpoint = at
  }
  private func flush(until: UInt64) throws {
    guard let value = pending, let encoder else { return }
    try encoder.append(value.buffer, at: value.ticks, duration: until - value.ticks)
    var frame: [String: Any] = ["index": frameIndex, "timeMs": elapsedMs(value.ticks, origin), "monotonicTicks": String(value.ticks),
      "partId": String(format: "part-%06d", encoder.index), "partFrame": encoder.frameCount - 1,
      "window": value.window?.payload as Any? ?? jsonNull, "blank": value.window == nil, "transform": jsonNull, "repeated": value.repeated]
    if let source = value.sourceTicks { frame["sourceTicks"] = String(source) }
    if let reason = value.gapReason { frame["gapReason"] = reason }
    if let window = value.window {
      let sourceWidth = max(1, Int(window.rect.width.rounded())), sourceHeight = max(1, Int(window.rect.height.rounded()))
      let scale = min(min(Double(canvasWidth) / Double(sourceWidth), Double(canvasHeight) / Double(sourceHeight)), window.scale)
      frame["transform"] = ["sourceWidth": sourceWidth, "sourceHeight": sourceHeight, "scale": scale,
        "offsetX": (Double(canvasWidth) - Double(sourceWidth) * scale) / 2, "offsetY": (Double(canvasHeight) - Double(sourceHeight) * scale) / 2,
        "sourceLeft": Double(window.rect.minX), "sourceTop": Double(window.rect.minY)]
    }
    var data = try jsonData(frame); data.append(10)
    try indexFile.write(contentsOf: data); frameHash.update(data: data); frameIndex += 1
    pending = nil
  }
  private func seal(end: UInt64) throws {
    guard let encoder else { return }
    try encoder.finish(end: end); try indexFile.synchronize()
    let size = try FileManager.default.attributesOfItem(atPath: encoder.file.path)[.size] as? NSNumber
    try atomicJSON(partsDirectory.appendingPathComponent(String(format: "%06d.json", encoder.index)), [
      "index": encoder.index, "startMs": elapsedMs(encoder.start, origin), "durationMs": elapsedMs(end, encoder.start),
      "startTicks": String(encoder.start), "endTicks": String(end), "clock": clock, "bytes": size?.uint64Value ?? 0,
      "sha256": try fileHash(encoder.file), "firstFrame": firstFrame, "frameCount": encoder.frameCount,
      "framesSha256": frameHash.finalize().map { String(format: "%02x", $0) }.joined()])
    self.encoder = nil; firstFrame = frameIndex; frameHash = SHA256()
  }
  func append(_ value: PendingCanvas) throws {
    guard value.ticks >= origin, value.ticks - origin < maximumDuration else { return }
    if let pending, value.ticks <= pending.ticks { return }
    try flush(until: value.ticks)
    if let encoder, value.ticks - encoder.start >= 10_000_000_000 { try seal(end: value.ticks) }
    if encoder == nil { partIndex += 1; encoder = try PartEncoder(directory: partsDirectory, index: partIndex, start: value.ticks) }
    pending = value
    if value.ticks - lastCheckpoint >= nativeFrequency { try checkpoint(value.ticks) }
  }
  func finish(at ticks: UInt64, complete: Bool) throws {
    let end = min(origin + maximumDuration, max(ticks, (pending?.ticks ?? origin) + 1))
    try flush(until: end); try seal(end: end)
    try checkpoint(end)
    try atomicJSON(directory.appendingPathComponent("capture-finished.json"), ["clock": clock, "durationMs": elapsedMs(end, origin), "complete": complete])
  }
}

// All task state belongs to the main run loop. The tap returns before doing AX
// work; ScreenCaptureKit's queue is bounded and never writes files or metadata.
@available(macOS 12.3, *)
final class TaskCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  let directory: URL
  let policy: TaskPolicy
  let lease: CaptureLease
  let video: VideoPackage
  let sessionId = UUID().uuidString.lowercased()
  var tap: CFMachPort?
  private var tapSource: CFRunLoopSource?
  private var workspaceObserver: NSObjectProtocol?
  private var sessionObservers: [NSObjectProtocol] = []
  private var sessionAvailable = true
  private var axObserver: AXObserver?
  private var observedPid: pid_t?
  private var signals: [DispatchSourceSignal] = []
  private var timer: Timer?
  private var stream: SCStream?
  private var requestedKey: String?
  private var target: WindowIdentity?
  private var lastCanvas: CVPixelBuffer?
  private var lastSourceTicks: UInt64?
  private var lastWrittenTicks: UInt64 = 0
  private var generationTicks: UInt64
  private var lastHeartbeat: UInt64 = 0
  private var sequence = 0
  private var lastEnvelopeTicks: UInt64 = 0
  private var paused = false
  private var stopping = false
  private var inputIncomplete = false
  private var queuedInputs = 0
  private var dragOrigins: [Int: (CGPoint, String)] = [:]
  private let queuedFramesLock = NSLock()
  private var queuedFrames = 0
  private let captureQueue = DispatchQueue(label: "memmy.task-video.frames", qos: .userInitiated)
  private let imageContext = CIContext(options: [.cacheIntermediates: false])
  private let black: CVPixelBuffer
  init(directory: URL) throws {
    let policy = try TaskPolicy(directory)
    self.directory = directory; self.policy = policy; lease = try CaptureLease(directory)
    try require(policy.parentPid == getppid() && permissions().values.allSatisfy { $0 }, "task_permissions_or_parent_invalid")
    let origin = hostTicks(); generationTicks = origin
    video = try VideoPackage(directory, origin: origin); black = try newCanvas()
    super.init()
  }
  private func emit(_ kind: String, event: [String: Any]? = nil, reason: String? = nil) {
    sequence += 1
    let at = max(lastEnvelopeTicks, min(hostTicks(), video.origin + maximumDuration)); lastEnvelopeTicks = at
    var value: [String: Any] = ["protocol": "memmy.macos.task-recording", "version": 1, "sessionId": sessionId,
      "pid": Int(getpid()), "parentPid": Int(policy.parentPid), "policySha256": policy.digest, "sequence": sequence,
      "kind": kind, "ticks": String(at), "clock": video.clock, "timeMs": elapsedMs(at, video.origin),
      "timestamp": ISO8601DateFormatter().string(from: Date()), "inputIncomplete": inputIncomplete]
    if let event { value["event"] = event }
    if let reason { value["reason"] = reason }
    outputJSON(value)
  }
  private func invalidate() {
    if !dragOrigins.isEmpty { inputIncomplete = true }
    generationTicks = hostTicks(); lastCanvas = nil; lastSourceTicks = nil; dragOrigins.removeAll()
  }
  private func observe(_ window: WindowIdentity) {
    guard observedPid != window.pid else { return }
    if let observer = axObserver { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
    axObserver = nil; observedPid = window.pid
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, _, _, pointer in
      guard let pointer else { return }
      let owner = Unmanaged<TaskCapture>.fromOpaque(pointer).takeUnretainedValue()
      owner.invalidate()
    }
    guard AXObserverCreate(window.pid, callback, &observer) == .success, let observer else { return }
    let application = AXUIElementCreateApplication(window.pid)
    for notification in [kAXFocusedWindowChangedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification, kAXUIElementDestroyedNotification] {
      _ = AXObserverAddNotification(observer, application, notification as CFString, Unmanaged.passUnretained(self).toOpaque())
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes); axObserver = observer
  }
  func start() throws {
    let mask = [CGEventType.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .keyDown, .scrollWheel]
      .reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    let callback: CGEventTapCallBack = { _, type, event, pointer in
      if let pointer {
        let owner = Unmanaged<TaskCapture>.fromOpaque(pointer).takeUnretainedValue()
        owner.receiveTap(type, event)
      }
      return Unmanaged.passUnretained(event)
    }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
      eventsOfInterest: mask, callback: callback, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { throw TaskFailure("input_tap_failed") }
    self.tap = tap
    tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes); CGEvent.tapEnable(tap: tap, enable: true)
    workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.invalidate() }
    for (notification, available) in [(NSWorkspace.sessionDidResignActiveNotification, false), (NSWorkspace.screensDidSleepNotification, false),
      (NSWorkspace.willSleepNotification, false), (NSWorkspace.sessionDidBecomeActiveNotification, true), (NSWorkspace.screensDidWakeNotification, true), (NSWorkspace.didWakeNotification, true)] {
      sessionObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
        self?.sessionAvailable = available; self?.invalidate()
      })
    }
    try video.append(PendingCanvas(buffer: black, ticks: video.origin, window: nil, sourceTicks: nil, repeated: false, gapReason: "unavailable"))
    lastWrittenTicks = video.origin
    emit("started")
    let timer = Timer(timeInterval: Double(frameInterval) / Double(nativeFrequency), repeats: true) { [weak self] _ in self?.tick() }
    self.timer = timer; RunLoop.main.add(timer, forMode: .common)
    for number in [SIGTERM, SIGINT] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler { [weak self] in self?.stop("process_exit") }; source.resume(); signals.append(source)
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while let line = readLine(strippingNewline: true) {
        let command = line
        DispatchQueue.main.async { self?.command(command) }
      }
      DispatchQueue.main.async { self?.stop("process_exit") }
    }
  }
  private func command(_ command: String) {
    guard !stopping else { return }
    if command == "stop" { stop("user_stopped"); return }
    guard (command == "pause" && !paused) || (command == "resume" && paused) else { stop("capture_failed"); return }
    paused = command == "pause"; invalidate()
    if paused { retireStream() }
    emit(paused ? "paused" : "resumed")
    tick()
  }
  private func receiveTap(_ type: CGEventType, _ event: CGEvent) {
    guard !stopping else { return }
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      inputIncomplete = true
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }
    if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 15
      && event.flags.contains([.maskCommand, .maskAlternate, .maskControl]) { stop("user_stopped"); return }
    guard !paused else { return }
    guard queuedInputs < 64 else { inputIncomplete = true; return }
    let ticks = event.timestamp
    guard let window = target, NSWorkspace.shared.frontmostApplication?.processIdentifier == window.pid else { return }
    guard ticks >= video.origin, ticks <= hostTicks(), let copy = event.copy() else { inputIncomplete = true; return }
    queuedInputs += 1
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }; self.queuedInputs -= 1
      guard !self.stopping, !self.paused else { return }
      guard ticks >= self.generationTicks, self.target?.key == window.key, frontWindow(self.policy)?.key == window.key,
            hostTicks() - ticks < nativeFrequency else { self.inputIncomplete = true; return }
      self.input(type, copy, window: window, ticks: ticks)
    }
  }
  private func input(_ type: CGEventType, _ event: CGEvent, window: WindowIdentity, ticks: UInt64) {
    let point = event.location
    var kind: String?, action: [String: Any] = [:]
    switch type {
    case .otherMouseDown, .otherMouseUp:
      guard window.rect.contains(point) else { return }
      kind = "unsupported_input"; inputIncomplete = true
    case .leftMouseDown, .rightMouseDown:
      guard window.rect.contains(point) else { return }
      dragOrigins[type == .leftMouseDown ? 0 : 1] = (point, window.key); return
    case .leftMouseUp, .rightMouseUp:
      let button = type == .leftMouseUp ? 0 : 1
      guard let origin = dragOrigins.removeValue(forKey: button), origin.1 == window.key else { inputIncomplete = true; return }
      if !window.rect.contains(point) || hypot(point.x - origin.0.x, point.y - origin.0.y) > 5 || event.getIntegerValueField(.mouseEventClickState) > 1 {
        kind = "unsupported_input"; inputIncomplete = true
      } else { kind = "mouse_click"; action = ["button": button == 0 ? "left" : "right", "x": Double(point.x), "y": Double(point.y)] }
    case .keyDown:
      let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
      let named: [Int: String] = [36: "Enter", 48: "Tab", 51: "Backspace", 53: "Escape", 115: "Home", 116: "PageUp",
        117: "Delete", 119: "End", 121: "PageDown", 123: "Left", 124: "Right", 125: "Down", 126: "Up"]
      // Physical US key identities are valid for shortcuts only on an ASCII
      // layout. Printable input is always redacted, never read from CGEvent.
      let ascii: [Int: String] = [0:"a",1:"s",2:"d",3:"f",4:"h",5:"g",6:"z",7:"x",8:"c",9:"v",11:"b",12:"q",13:"w",14:"e",15:"r",16:"y",17:"t",18:"1",19:"2",20:"3",21:"4",22:"6",23:"5",24:"=",25:"9",26:"7",27:"-",28:"8",29:"0",30:"]",31:"o",32:"u",33:"[",34:"i",35:"p",37:"l",38:"j",39:"'",40:"k",41:";",42:"\\",43:",",44:"/",45:"n",46:"m",47:".",49:"Space",50:"`"]
      let shortcut = event.flags.contains(.maskCommand) || event.flags.contains(.maskControl)
      var modifiers: [String] = []
      if event.flags.contains(.maskControl) { modifiers.append("Control") }
      if event.flags.contains(.maskAlternate) { modifiers.append("Option") }
      if event.flags.contains(.maskShift) { modifiers.append("Shift") }
      if event.flags.contains(.maskCommand) { modifiers.append("Command") }
      let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
      let layoutId = source.flatMap { TISGetInputSourceProperty($0, kTISPropertyInputSourceID) }.map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String }
      let asciiLayout = layoutId == "com.apple.keylayout.US" || layoutId == "com.apple.keylayout.ABC"
      if !IsSecureEventInputEnabled(), let key = named[code] ?? (shortcut && asciiLayout ? ascii[code] : nil) {
        kind = "key_press"; action = ["key": (modifiers + [key]).joined(separator: "+"), "pressCount": 1]
      } else if shortcut && !IsSecureEventInputEnabled() { kind = "unsupported_input"; inputIncomplete = true }
      else { kind = "text_input"; action = ["redacted": true] }
    case .scrollWheel:
      guard window.rect.contains(point) else { return }
      let continuous = event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
      let vertical = event.getIntegerValueField(continuous ? .scrollWheelEventPointDeltaAxis1 : .scrollWheelEventDeltaAxis1)
      let horizontal = event.getIntegerValueField(continuous ? .scrollWheelEventPointDeltaAxis2 : .scrollWheelEventDeltaAxis2)
      if vertical != 0 && horizontal != 0 { kind = "unsupported_input"; inputIncomplete = true }
      else if vertical != 0 || horizontal != 0 {
        let value = vertical != 0 ? vertical : horizontal
        kind = "scroll"; action = ["delta": Int(min(abs(value), 100_000)) * (continuous ? 1 : 100), "deltaUnit": "pixels",
          "direction": vertical != 0 ? (value > 0 ? "up" : "down") : (value > 0 ? "left" : "right")]
      }
    default: break
    }
    if let kind { emit("input", event: ["type": kind, "ticks": String(ticks), "window": window.payload, "action": action]) }
  }
  private func retireStream() {
    let previous = stream; stream = nil; target = nil; requestedKey = nil; invalidate()
    previous?.stopCapture { _ in }
  }
  private func select(_ window: WindowIdentity?) {
    guard target?.key != window?.key || (window != nil && requestedKey == nil) else { return }
    retireStream()
    guard let window, !paused, !stopping else { return }
    target = window; requestedKey = window.key; observe(window)
    let generation = generationTicks
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, error in
      DispatchQueue.main.async {
        guard let self, !self.stopping, !self.paused, self.requestedKey == window.key, self.generationTicks >= generation else { return }
        guard error == nil, let scWindow = content?.windows.first(where: { $0.windowID == window.id && $0.owningApplication?.processID == window.pid }) else {
          if error != nil { self.stop("capture_failed") }; return
        }
        guard frontWindow(self.policy)?.key == window.key else { return }
        let configuration = SCStreamConfiguration()
        let scale = min(min(Double(canvasWidth) / Double(window.rect.width), Double(canvasHeight) / Double(window.rect.height)), window.scale)
        configuration.width = max(1, Int((Double(window.rect.width) * scale).rounded()))
        configuration.height = max(1, Int((Double(window.rect.height) * scale).rounded()))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA; configuration.minimumFrameInterval = mediaTime(frameInterval)
        configuration.queueDepth = 3; configuration.showsCursor = false; configuration.scalesToFit = true
        if #available(macOS 13.0, *) { configuration.capturesAudio = false }
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: scWindow), configuration: configuration, delegate: self)
        do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.captureQueue) }
        catch { self.stop("capture_failed"); return }
        self.stream = stream
        stream.startCapture { [weak self, weak stream] error in
          if error != nil { DispatchQueue.main.async { if let self, self.stream === stream { self.stop("capture_failed") } } }
        }
      }
    }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    DispatchQueue.main.async { [weak self, weak stream] in if let self, self.stream === stream, !self.stopping { self.stop("capture_failed") } }
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen else { return }
    queuedFramesLock.lock()
    if queuedFrames >= 3 { queuedFramesLock.unlock(); DispatchQueue.main.async { [weak self] in self?.stop("capture_failed") }; return }
    queuedFrames += 1; queuedFramesLock.unlock()
    DispatchQueue.main.async { [weak self, weak stream] in
      guard let self else { return }
      defer { self.queuedFramesLock.lock(); self.queuedFrames -= 1; self.queuedFramesLock.unlock() }
      guard let stream, self.stream === stream, !self.stopping, !self.paused else { return }
      self.receiveFrame(sample)
    }
  }
  private func receiveFrame(_ sample: CMSampleBuffer) {
    guard sample.isValid, let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let attachment = attachments.first, let status = attachment[.status] as? Int else { return }
    if status == SCFrameStatus.idle.rawValue { return }
    guard status == SCFrameStatus.complete.rawValue, let buffer = sample.imageBuffer, let window = target,
          let sourceTicks = hostNanoseconds(sample.presentationTimeStamp), sourceTicks >= generationTicks,
          sourceTicks >= video.origin, sourceTicks <= hostTicks(), frontWindow(policy)?.key == window.key,
          let rectData = attachment[.contentRect] as? [String: Any], let rect = CGRect(dictionaryRepresentation: rectData as CFDictionary) else { return }
    if let display = attachment[.displayTime] as? UInt64, let displayNs = hostNanosecondsFromMach(display), abs(Double(displayNs) - Double(sourceTicks)) > 100_000_000 { return }
    if let lastSourceTicks, sourceTicks <= lastSourceTicks { return }
    let image = CIImage(cvPixelBuffer: buffer), bounds = image.extent
    // SCK's contentRect is in output-surface pixels; contentScale and
    // scaleFactor describe how that rectangle relates to source points.
    let content = rect
    guard content.width > 0, content.height > 0, content.minX >= -1, content.minY >= -1,
          content.maxX <= bounds.width + 1, content.maxY <= bounds.height + 1,
          abs(Double(content.width / content.height - window.rect.width / window.rect.height)) < 0.01 else { return }
    // Crop the native content rectangle, excluding SCK window shadows, then
    // letterbox at the exact transform recorded with this frame.
    let crop = CGRect(x: content.minX, y: bounds.height - content.maxY, width: content.width, height: content.height).intersection(bounds)
    let sourceWidth = Double(max(1, Int(window.rect.width.rounded()))), sourceHeight = Double(max(1, Int(window.rect.height.rounded())))
    let scale = min(min(Double(canvasWidth) / sourceWidth, Double(canvasHeight) / sourceHeight), window.scale)
    let width = sourceWidth * scale, height = sourceHeight * scale
    do {
      let canvas = try newCanvas()
      let positioned = image.cropped(to: crop).transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
        .transformed(by: CGAffineTransform(scaleX: width / crop.width, y: height / crop.height))
        .transformed(by: CGAffineTransform(translationX: (Double(canvasWidth) - width) / 2, y: (Double(canvasHeight) - height) / 2))
      imageContext.render(positioned, to: canvas, bounds: CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight), colorSpace: CGColorSpaceCreateDeviceRGB())
      guard frontWindow(policy)?.key == window.key, sourceTicks >= generationTicks else { return }
      lastCanvas = canvas; lastSourceTicks = sourceTicks
    } catch { stop("capture_failed") }
  }
  private func tick() {
    guard !stopping else { return }
    let at = hostTicks()
    if at - video.origin >= maximumDuration { stop("duration_limit"); return }
    if kill(policy.parentPid, 0) != 0 && errno == ESRCH { stop("process_exit"); return }
    if at - lastHeartbeat >= nativeFrequency {
      if !permissions().values.allSatisfy({ $0 }) { stop("capture_failed"); return }
      emit("heartbeat"); lastHeartbeat = at
    }
    if !paused && IsSecureEventInputEnabled() { inputIncomplete = true }
    let window = paused || !sessionAvailable ? nil : frontWindow(policy)
    select(window)
    let canvas = lastCanvas, source = lastSourceTicks
    let usable = !paused && window != nil && target?.key == window?.key && canvas != nil && source != nil && source! >= generationTicks
    // Repeated display frames retain their source timestamp and cannot serve
    // as fresh before/after evidence in OpenAdapt exports.
    let fresh = usable && source! > lastWrittenTicks
    let ticks = fresh ? source! : at
    if ticks <= lastWrittenTicks || ticks - lastWrittenTicks < frameInterval { return }
    let gap = paused ? "paused" : (window == nil && NSWorkspace.shared.frontmostApplication.map({ !policy.allows($0) }) == true ? "unauthorized" : "unavailable")
    do {
      try video.append(PendingCanvas(buffer: usable ? canvas! : black, ticks: ticks, window: usable ? window : nil,
        sourceTicks: usable ? source : nil, repeated: usable && !fresh, gapReason: usable ? nil : gap))
      lastWrittenTicks = ticks
    } catch { stop("capture_failed") }
  }
  private func stop(_ reason: String) {
    guard !stopping else { return }; stopping = true
    timer?.invalidate(); timer = nil
    if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }; tap = nil
    if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }; tapSource = nil
    if let observer = workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }; workspaceObserver = nil
    for observer in sessionObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }; sessionObservers.removeAll()
    if let observer = axObserver { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }; axObserver = nil
    retireStream()
    var result = reason
    do { try video.finish(at: hostTicks(), complete: reason == "user_stopped" || reason == "duration_limit") }
    catch { result = "capture_failed" }
    emit("stopped", reason: result)
    exit(result == "capture_failed" ? 2 : 0)
  }
}

// MARK: - Sealed-prefix recovery and compressed H.264 remux

struct SealedPart {
  let index: Int
  let file: URL
  let start: UInt64
  let end: UInt64
  let firstFrame: Int
  let frameCount: Int
  let bytes: UInt64
  let digest: String
  var payload: [String: Any] { ["index": index, "startMs": Double(start) / 1_000_000, "durationMs": Double(end - start) / 1_000_000, "bytes": bytes, "sha256": digest] }
}
func readerFor(_ file: URL, decoded: Bool) throws -> (AVAssetReader, AVAssetReaderTrackOutput, CMFormatDescription) {
  try regularFile(file)
  let asset = AVURLAsset(url: file)
  let tracks = asset.tracks(withMediaType: .video)
  try require(tracks.count == 1 && asset.tracks(withMediaType: .audio).isEmpty, "invalid_video_tracks")
  let track = tracks[0]
  try require(track.naturalSize == CGSize(width: canvasWidth, height: canvasHeight), "invalid_video_dimensions")
  guard let firstFormat = track.formatDescriptions.first else { throw TaskFailure("video_format_missing") }
  let format = firstFormat as! CMFormatDescription
  try require(CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264, "video_codec_invalid")
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: decoded ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] : nil)
  output.alwaysCopiesSampleData = false
  try require(reader.canAdd(output), "reader_output_failed"); reader.add(output)
  try require(reader.startReading(), "reader_start_failed")
  return (reader, output, format)
}
func nextVideoSample(_ output: AVAssetReaderTrackOutput) -> CMSampleBuffer? {
  // AVAssetReader can return marker-only buffers, especially for compressed
  // output. They have no video samples and must not consume a frame index.
  while let sample = output.copyNextSampleBuffer() {
    if sample.numSamples > 0 { return sample }
  }
  return nil
}
func validatePart(_ part: SealedPart, frames: [[String: Any]], origin: UInt64) throws {
  let (reader, output, _) = try readerFor(part.file, decoded: false)
  var count = 0, last: UInt64?, endpoint: UInt64 = 0
  while let sample = nextVideoSample(output) {
    guard let pts = hostNanoseconds(sample.presentationTimeStamp), let duration = hostNanoseconds(sample.duration) else { throw TaskFailure("part_timing_invalid") }
    try require(duration > 0 && (last == nil || pts > last!) && pts < part.end - part.start && count < part.frameCount, "part_timing_invalid")
    let frame = frames[part.firstFrame + count]
    guard let ticksString = frame["monotonicTicks"] as? String, let ticks = UInt64(ticksString) else { throw TaskFailure("frame_ticks_invalid") }
    try require(abs(Double(ticks - origin) - Double(part.start + pts)) < 2_000_000, "frame_sample_mismatch")
    if count == 0 {
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
      try require(pts < 2_000_000 && (attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) != true, "part_not_independently_decodable")
    }
    endpoint = pts + duration; last = pts; count += 1
  }
  try require(reader.status == .completed && count == part.frameCount && abs(Double(endpoint) - Double(part.end - part.start)) < 2_000_000, "part_tail_invalid")
}
func replaceMediaFile(_ url: URL) throws {
  if FileManager.default.fileExists(atPath: url.path) { try regularFile(url); try FileManager.default.removeItem(at: url) }
}
func remux(_ directory: URL, _ parts: [SealedPart]) throws {
  try require(!parts.isEmpty, "no_sealed_parts")
  let temporary = directory.appendingPathComponent("recording-remux.mp4")
  try replaceMediaFile(temporary)
  let (_, _, format) = try readerFor(parts[0].file, decoded: false)
  let writer = try AVAssetWriter(outputURL: temporary, fileType: .mp4)
  writer.shouldOptimizeForNetworkUse = true
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: format)
  input.mediaTimeScale = videoTimescale; input.expectsMediaDataInRealTime = false
  try require(writer.canAdd(input), "remux_input_failed"); writer.add(input)
  try require(writer.startWriting(), "remux_start_failed"); writer.startSession(atSourceTime: .zero)
  do {
    for part in parts {
      let (reader, output, partFormat) = try readerFor(part.file, decoded: false)
      try require(CMFormatDescriptionEqual(format, otherFormatDescription: partFormat), "part_codec_configuration_changed")
      while let sample = nextVideoSample(output) {
        var timing = CMSampleTimingInfo(duration: sample.duration, presentationTimeStamp: CMTimeAdd(sample.presentationTimeStamp, mediaTime(part.start)),
          decodeTimeStamp: sample.decodeTimeStamp.isValid ? CMTimeAdd(sample.decodeTimeStamp, mediaTime(part.start)) : .invalid)
        var shifted: CMSampleBuffer?
        try require(CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: 1,
          sampleTimingArray: &timing, sampleBufferOut: &shifted) == noErr, "remux_timing_failed")
        guard let shifted else { throw TaskFailure("remux_timing_failed") }
        let deadline = hostTicks() + 15 * nativeFrequency
        while !input.isReadyForMoreMediaData && writer.status == .writing && hostTicks() < deadline { usleep(1000) }
        try require(input.isReadyForMoreMediaData && input.append(shifted), "remux_append_failed")
      }
      try require(reader.status == .completed, "remux_read_failed")
    }
    writer.endSession(atSourceTime: mediaTime(parts.last!.end)); input.markAsFinished()
    let done = DispatchSemaphore(value: 0); writer.finishWriting { done.signal() }
    try require(done.wait(timeout: .now() + 30) == .success, "remux_finish_timeout")
    try require(writer.status == .completed, "remux_finish_failed")
    try syncFile(temporary)
    // Verify final sample count and timestamps, not just a nonempty container.
    let (reader, output, _) = try readerFor(temporary, decoded: false)
    var count = 0, last: UInt64?, endpoint: UInt64 = 0
    while let sample = nextVideoSample(output) {
      guard let pts = hostNanoseconds(sample.presentationTimeStamp), let duration = hostNanoseconds(sample.duration) else { throw TaskFailure("remux_verification_failed") }
      try require(last == nil || pts > last!, "remux_order_invalid"); last = pts; endpoint = pts + duration; count += 1
    }
    try require(reader.status == .completed && count == parts.reduce(0, { $0 + $1.frameCount }) && abs(Double(endpoint) - Double(parts.last!.end)) < 2_000_000, "remux_verification_failed")
    let final = directory.appendingPathComponent("recording.mp4"); try replaceMediaFile(final)
    try FileManager.default.moveItem(at: temporary, to: final); try syncFile(final)
  } catch { writer.cancelWriting(); try? FileManager.default.removeItem(at: temporary); throw error }
}
func finalizePackage(_ directory: URL) throws {
  let lease = try CaptureLease(directory, wait: true); defer { withExtendedLifetime(lease) {} }
  let policy = try TaskPolicy(directory)
  let state = try readJSON(directory.appendingPathComponent("capture-state.json"))
  guard let clock = state["clock"] as? [String: String], clock["kind"] == "mach_host", clock["frequency"] == String(nativeFrequency),
        let originString = clock["origin"], let origin = UInt64(originString), let expectedDuration = state["durationMs"] as? Double,
        expectedDuration.isFinite, expectedDuration >= 0, expectedDuration <= 1_200_000.1 else { throw TaskFailure("recovery_clock_invalid") }
  let partsDirectory = directory.appendingPathComponent("parts")
  let values = try partsDirectory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  try require(values.isDirectory == true && values.isSymbolicLink != true, "parts_directory_invalid")
  let frameFile = directory.appendingPathComponent("frames.jsonl")
  try regularFile(frameFile, maximum: 64 * 1024 * 1024)
  let raw = try Data(contentsOf: frameFile)
  var lines: [Data] = [], frames: [[String: Any]] = []
  for line in raw.split(separator: 10, omittingEmptySubsequences: false).dropLast() {
    guard !line.isEmpty, let value = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { break }
    var bytes = Data(line); bytes.append(10); lines.append(bytes); frames.append(value)
  }
  var parts: [SealedPart] = [], verifiedFrames = 0, validBytes = Data(), invalidPart = false
  let names = try FileManager.default.contentsOfDirectory(atPath: partsDirectory.path)
  for index in 1...121 {
    let stem = String(format: "%06d", index)
    guard names.contains(stem + ".json") else { if names.contains(stem + ".mp4") { invalidPart = true }; break }
    do {
      let value = try readJSON(partsDirectory.appendingPathComponent(stem + ".json"))
      guard value["index"] as? Int == index, value["clock"] as? [String: String] == clock,
            let startString = value["startTicks"] as? String, let start = UInt64(startString),
            let endString = value["endTicks"] as? String, let end = UInt64(endString), end > start, start >= origin, end - origin <= maximumDuration + frameInterval,
            let first = value["firstFrame"] as? Int, first == verifiedFrames, let count = value["frameCount"] as? Int, count > 0, count <= 152,
            first + count <= frames.count, let digest = value["sha256"] as? String, let framesDigest = value["framesSha256"] as? String,
            let bytes = value["bytes"] as? NSNumber, bytes.uint64Value > 0 else { throw TaskFailure("sealed_part_invalid") }
      try require(start - origin == (parts.last?.end ?? 0), "sealed_part_order_invalid")
      let file = partsDirectory.appendingPathComponent(stem + ".mp4")
      try regularFile(file)
      let size = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber
      let actualHash = try fileHash(file)
      try require(actualHash == digest && size?.uint64Value == bytes.uint64Value, "sealed_part_hash_invalid")
      var frameBytes = Data()
      var lastTicks: UInt64?
      for offset in 0..<count {
        let frame = frames[first + offset]
        guard frame["index"] as? Int == first + offset, frame["partFrame"] as? Int == offset, frame["partId"] as? String == "part-" + stem,
              let ticksString = frame["monotonicTicks"] as? String, let ticks = UInt64(ticksString), ticks >= start, ticks < end,
              let time = frame["timeMs"] as? Double, abs(time - elapsedMs(ticks, origin)) < 2, lastTicks == nil || ticks > lastTicks!,
              let blank = frame["blank"] as? Bool else { throw TaskFailure("sealed_frame_invalid") }
        if blank { try require(frame["window"] is NSNull && frame["transform"] is NSNull, "sealed_blank_frame_invalid") }
        else { guard let window = frame["window"] as? [String: Any], policy.allowsWindow(window), frame["transform"] is [String: Any] else { throw TaskFailure("sealed_window_invalid") } }
        lastTicks = ticks; frameBytes.append(lines[first + offset])
      }
      try require(sha256(frameBytes) == framesDigest, "sealed_frame_hash_invalid")
      let part = SealedPart(index: index, file: file, start: start - origin, end: end - origin, firstFrame: first,
        frameCount: count, bytes: bytes.uint64Value, digest: digest)
      try validatePart(part, frames: frames, origin: origin)
      parts.append(part); verifiedFrames += count; validBytes.append(frameBytes)
    } catch { invalidPart = true; break }
  }
  // An incomplete index line and an unsealed MP4 are never promoted to evidence.
  try validBytes.write(to: frameFile, options: .atomic); try syncFile(frameFile)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: frameFile.path)
  let sealedEnd = Double(parts.last?.end ?? 0) / 1_000_000
  let duration = max(sealedEnd, expectedDuration)
  var gaps: [[String: Any]] = []
  for index in 0..<verifiedFrames {
    let frame = frames[index]
    guard frame["blank"] as? Bool == true, let start = frame["timeMs"] as? Double else { continue }
    let end = index + 1 < verifiedFrames ? frames[index + 1]["timeMs"] as? Double ?? sealedEnd : sealedEnd
    let reason = frame["gapReason"] as? String ?? "unavailable"
    if let last = gaps.last, last["reason"] as? String == reason, last["endMs"] as? Double == start {
      gaps[gaps.count - 1]["endMs"] = end
    } else { gaps.append(["startMs": start, "endMs": end, "reason": reason]) }
  }
  if duration > sealedEnd { gaps.append(["startMs": sealedEnd, "endMs": duration, "reason": "missing_tail"]) }
  let finished = try? readJSON(directory.appendingPathComponent("capture-finished.json"))
  var complete = finished?["complete"] as? Bool == true && finished?["clock"] as? [String: String] == clock
    && !invalidPart && !parts.isEmpty && abs(duration - sealedEnd) < 2 && verifiedFrames == frames.count && raw == validBytes
  var failure: String? = complete ? nil : "recording_interrupted_or_unsealed_tail"
  func save() throws {
    try atomicJSON(directory.appendingPathComponent("native-media.json"), ["version": 1, "platform": "macos", "clock": clock,
      "durationMs": duration, "width": canvasWidth, "height": canvasHeight, "complete": complete, "error": failure as Any? ?? jsonNull,
      "gaps": gaps, "parts": parts.map { $0.payload }])
  }
  // Persist the verified fragment inventory even when the full remux fails.
  try save()
  do { try remux(directory, parts) }
  catch { complete = false; failure = "recording_remux_failed"; try? replaceMediaFile(directory.appendingPathComponent("recording.mp4")) }
  try save()
}
func writePNG(_ sample: CMSampleBuffer, to file: URL, context: CIContext) throws {
  guard let buffer = sample.imageBuffer, CVPixelBufferGetWidth(buffer) == canvasWidth, CVPixelBufferGetHeight(buffer) == canvasHeight,
        let image = context.createCGImage(CIImage(cvPixelBuffer: buffer), from: CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight)),
        let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil) else { throw TaskFailure("png_create_failed") }
  CGImageDestinationAddImage(destination, image, nil)
  try require(CGImageDestinationFinalize(destination), "png_write_failed"); try syncFile(file)
}
func exportFrames(_ directory: URL, destination: URL) throws {
  let lease = try CaptureLease(directory, wait: true); defer { withExtendedLifetime(lease) {} }
  try require(destination.standardizedFileURL.path.hasPrefix(directory.standardizedFileURL.path + "/exports/"), "export_directory_invalid")
  let destinationValues = try destination.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  try require(destinationValues.isDirectory == true && destinationValues.isSymbolicLink != true, "export_directory_invalid")
  let requestFile = destination.appendingPathComponent("frame-requests.json")
  try regularFile(requestFile, maximum: 1024 * 1024)
  guard let requests = try JSONSerialization.jsonObject(with: Data(contentsOf: requestFile)) as? [[String: Any]], requests.count <= 2000 else { throw TaskFailure("frame_requests_invalid") }
  let media = try readJSON(directory.appendingPathComponent("native-media.json"))
  guard media["complete"] as? Bool == true, let parts = media["parts"] as? [[String: Any]] else { throw TaskFailure("export_media_incomplete") }
  let frameFile = directory.appendingPathComponent("frames.jsonl")
  try regularFile(frameFile, maximum: 64 * 1024 * 1024)
  let frames = try Data(contentsOf: frameFile).split(separator: 10).map { try JSONSerialization.jsonObject(with: Data($0)) as? [String: Any] ?? [:] }
  let framesDirectory = destination.appendingPathComponent("frames")
  try FileManager.default.createDirectory(at: framesDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  let context = CIContext(options: [.cacheIntermediates: false])
  var written = 0
  for part in parts {
    guard let index = part["index"] as? Int, index > 0, index <= 999999, let hash = part["sha256"] as? String else { throw TaskFailure("export_part_invalid") }
    let id = String(format: "part-%06d", index), selected = requests.filter { $0["partId"] as? String == id }
    if selected.isEmpty { continue }
    let file = directory.appendingPathComponent(String(format: "parts/%06d.mp4", index))
    let actualHash = try fileHash(file); try require(actualHash == hash, "export_part_hash_invalid")
    let (reader, output, _) = try readerFor(file, decoded: true)
    var frameIndex = 0
    while let sample = nextVideoSample(output) {
      for request in selected where request["partFrame"] as? Int == frameIndex {
        guard let flowIndex = request["i"] as? Int, flowIndex >= 0, flowIndex < 1000, let phase = request["phase"] as? String,
              phase == "before" || phase == "after", let sourceIndex = request["frameId"] as? Int, sourceIndex >= 0, sourceIndex < frames.count,
              frames[sourceIndex]["partId"] as? String == id, frames[sourceIndex]["partFrame"] as? Int == frameIndex,
              frames[sourceIndex]["blank"] as? Bool == false, frames[sourceIndex]["repeated"] as? Bool != true else { throw TaskFailure("export_frame_request_invalid") }
        try writePNG(sample, to: framesDirectory.appendingPathComponent(String(format: "%04d_%@.png", flowIndex, phase)), context: context); written += 1
      }
      frameIndex += 1
    }
    try require(reader.status == .completed, "export_decode_failed")
  }
  try require(written == requests.count, "export_frames_missing")
}

#if MEMMY_RECORDING_TESTS
// Compiled only by the native CI test, never included in a shipped helper.
func nativeMediaSelfTest(_ directory: URL) throws {
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  try atomicJSON(directory.appendingPathComponent("policy.json"), ["version": 1, "parentPid": Int(getpid()), "maxDurationMs": 1_200_000,
    "applications": [["bundleId": "test.memmy.native", "pid": Int(getpid()), "processStart": "1", "executable": "/test/native"]]])
  let canvas = try newCanvas()
  CVPixelBufferLockBaseAddress(canvas, [])
  guard let base = CVPixelBufferGetBaseAddress(canvas)?.assumingMemoryBound(to: UInt8.self) else { throw TaskFailure("test_canvas_missing") }
  for y in 0..<canvasHeight { for x in 0..<canvasWidth {
    let offset = y * CVPixelBufferGetBytesPerRow(canvas) + x * 4
    base[offset] = y < canvasHeight / 2 ? 0 : 255; base[offset + 1] = 0; base[offset + 2] = y < canvasHeight / 2 ? 255 : 0; base[offset + 3] = 255
  } }
  CVPixelBufferUnlockBaseAddress(canvas, [])
  let origin: UInt64 = 10_000_000_000
  let window = WindowIdentity(pid: getpid(), id: 1, bundleId: "test.memmy.native", executable: "/test/native", start: "1",
    rect: CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight), scale: 1)
  do {
    let package = try VideoPackage(directory, origin: origin)
    // The 9.87 s held frame exceeds the MP4 sample-duration limit at a 1 GHz
    // track timescale. Validate its timing through sealing, remux and recovery.
    for relative in [UInt64(0), 70_000_000, 140_000_000, 10_010_000_000, 10_080_000_000, 10_150_000_000] {
      let blank = relative == 10_080_000_000
      try package.append(PendingCanvas(buffer: blank ? newCanvas() : canvas, ticks: origin + relative, window: blank ? nil : window,
        sourceTicks: blank ? nil : origin + relative, repeated: false, gapReason: blank ? "paused" : nil))
    }
    try package.finish(at: origin + 10_220_000_000, complete: true)
  }
  try finalizePackage(directory)
  let media = try readJSON(directory.appendingPathComponent("native-media.json"))
  try require(media["complete"] as? Bool == true && (media["parts"] as? [Any])?.count == 2, "test_sealed_parts_failed")
  let (reader, output, _) = try readerFor(directory.appendingPathComponent("recording.mp4"), decoded: true)
  guard let first = nextVideoSample(output), let buffer = first.imageBuffer else { throw TaskFailure("test_decode_failed") }
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  guard let pixels = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { throw TaskFailure("test_pixels_missing") }
  let bottom = (canvasHeight - 1) * CVPixelBufferGetBytesPerRow(buffer)
  let orientation = pixels[2] > 200 && pixels[0] < 40 && pixels[bottom] > 200 && pixels[bottom + 2] < 40
  CVPixelBufferUnlockBaseAddress(buffer, .readOnly); reader.cancelReading()
  try require(orientation, "test_color_orientation_failed")
  let destination = directory.appendingPathComponent("exports/native-test")
  try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
  try atomicJSON(destination.appendingPathComponent("frame-requests.json"), [
    ["i": 0, "phase": "before", "frameId": 0, "partId": "part-000001", "partFrame": 0],
    ["i": 0, "phase": "after", "frameId": 3, "partId": "part-000002", "partFrame": 0]])
  try exportFrames(directory, destination: destination)
  let png = destination.appendingPathComponent("frames/0000_before.png")
  guard let source = CGImageSourceCreateWithURL(png as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw TaskFailure("test_png_invalid") }
  try require(image.width == canvasWidth && image.height == canvasHeight, "test_png_dimensions_failed")
  // Remove the clean stop marker and append an unsealed, broken tail. Recovery
  // must retain exactly the verified two parts and six original timestamps.
  try FileManager.default.removeItem(at: directory.appendingPathComponent("capture-finished.json"))
  try Data([0, 1, 2]).write(to: directory.appendingPathComponent("parts/000003.mp4"))
  let file = try FileHandle(forWritingTo: directory.appendingPathComponent("frames.jsonl"))
  try file.seekToEnd(); try file.write(contentsOf: Data("{broken-tail".utf8)); try file.close()
  try finalizePackage(directory)
  let recovered = try readJSON(directory.appendingPathComponent("native-media.json"))
  try require(recovered["complete"] as? Bool == false && (recovered["parts"] as? [Any])?.count == 2, "test_recovery_failed")
  let recoveredFrames = try String(contentsOf: directory.appendingPathComponent("frames.jsonl"), encoding: .utf8).split(separator: "\n")
  try require(recoveredFrames.count == 6, "test_recovery_frame_prefix_failed")
  outputJSON(["nativeMediaTests": "passed", "parts": 2, "frames": 6])
}
#endif

// MARK: - Command line

let taskArguments = Array(CommandLine.arguments.dropFirst())
func argument(_ name: String) throws -> String {
  guard let index = taskArguments.firstIndex(of: name), index + 1 < taskArguments.count, !taskArguments[index + 1].hasPrefix("--") else { throw TaskFailure("missing_argument") }
  return taskArguments[index + 1]
}
do {
  if taskArguments.contains("--configuration") {
    let request = ["accessibility", "inputMonitoring", "screenRecording"].first { taskArguments.contains("--request-" + $0) }
    var supported = false
    if #available(macOS 12.3, *) { supported = true }
    outputJSON(["supported": supported, "permissions": permissions(request), "applications": runningApplications()]); exit(0)
  }
  let directory = URL(fileURLWithPath: try argument("--output-dir"), isDirectory: true).standardizedFileURL
  let directoryValues = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  try require(directoryValues.isDirectory == true && directoryValues.isSymbolicLink != true, "output_directory_invalid")
  if taskArguments.contains("--finalize-task") { try finalizePackage(directory); exit(0) }
  if taskArguments.contains("--export-task-frames") {
    try exportFrames(directory, destination: URL(fileURLWithPath: try argument("--export-dir"), isDirectory: true)); exit(0)
  }
  #if MEMMY_RECORDING_TESTS
  if taskArguments.contains("--self-test") { try nativeMediaSelfTest(directory); exit(0) }
  #endif
  guard taskArguments.contains("--record-task") else { throw TaskFailure("unknown_command") }
  if #available(macOS 12.3, *) {
    let capture = try TaskCapture(directory: directory)
    try capture.start(); withExtendedLifetime(capture) { CFRunLoopRun() }
  } else { throw TaskFailure("macos_12_3_required") }
} catch {
  // No native UI text, input values, window titles or paths reach stderr.
  let code = (error as? TaskFailure)?.code ?? "native_task_operation_failed"
  FileHandle.standardError.write(Data((code + "\n").utf8)); exit(2)
}
