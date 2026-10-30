import Foundation
import Darwin

// Source-only diagnostics. Packaged Memmy runs human-recorder.swift in the
// Memmy Computer Use.app process, using its LaunchServices permission identity.
let arguments = Set(CommandLine.arguments.dropFirst())
if arguments.contains("--permissions") || arguments.contains("--request-permissions") {
  emit(permissionsPayload(
    request: arguments.contains("--request-permissions"),
    requestInputMonitoring: arguments.contains("--request-input-monitoring"),
    requestScreenRecording: arguments.contains("--request-screen-recording"),
    requestAccessibility: arguments.contains("--request-accessibility")
  ))
  exit(0)
}

do {
  try startHistoryRecorder(output: { line in print(line); fflush(stdout) })
} catch {
  FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
  exit(2)
}
signal(SIGTERM) { _ in stopHistoryRecorder(); exit(0) }
signal(SIGINT) { _ in stopHistoryRecorder(); exit(0) }
let controls = isatty(STDIN_FILENO) == 0 ? HistoryControlInput(fileDescriptor: STDIN_FILENO,
  onCheckpoint: { id in DispatchQueue.main.async { checkpointHistoryRecorder(id: id) } },
  onEnd: { DispatchQueue.main.async { CFRunLoopStop(CFRunLoopGetMain()) } }) : nil
CFRunLoopRun()
controls?.cancel()
stopHistoryRecorder()
