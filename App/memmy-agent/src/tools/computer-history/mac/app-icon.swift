import AppKit
import Foundation

// Prints one application's icon as base64 PNG, given its bundle identifier.
//
// NSWorkspace is the only thing that answers for every application. Modern
// bundles ship their icon inside a compiled asset catalog with no .icns to
// read, so reaching into Contents/Resources finds nothing for them, while
// NSWorkspace returns the same icon the Dock and Finder draw.

if CommandLine.arguments.contains("--list-apps") {
  var applications: [String: String] = [:]
  func add(_ url: URL) {
    guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { return }
    applications[id] = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
      ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
      ?? url.deletingPathExtension().lastPathComponent
  }
  for directory in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
    guard let items = FileManager.default.enumerator(at: URL(fileURLWithPath: directory),
      includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
    for case let url as URL in items where url.pathExtension == "app" { add(url) }
  }
  for app in NSWorkspace.shared.runningApplications { if let url = app.bundleURL { add(url) } }
  let rows = applications.map { ["bundleId": $0.key, "name": $0.value] }
    .sorted { ($0["name"] ?? "").localizedCaseInsensitiveCompare($1["name"] ?? "") == .orderedAscending }
  let data = try JSONSerialization.data(withJSONObject: rows)
  FileHandle.standardOutput.write(data)
  exit(0)
}

let size = 64

guard let bundleId = CommandLine.arguments.dropFirst().first, !bundleId.isEmpty else {
  FileHandle.standardError.write("usage: app-icon <bundle-id>\n".data(using: .utf8)!)
  exit(2)
}

guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
  // Not installed, or not an application bundle. The caller renders a
  // placeholder rather than treating this as a failure.
  exit(3)
}

let icon = NSWorkspace.shared.icon(forFile: url.path)
let target = NSSize(width: size, height: size)
let scaled = NSImage(size: target)
scaled.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high
icon.draw(
  in: NSRect(origin: .zero, size: target),
  from: NSRect(origin: .zero, size: icon.size),
  operation: .copy,
  fraction: 1.0
)
scaled.unlockFocus()

guard let tiff = scaled.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:])
else {
  exit(4)
}

print(png.base64EncodedString())
