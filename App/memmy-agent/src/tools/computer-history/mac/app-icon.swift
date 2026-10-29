import AppKit
import Foundation

// Prints one application's icon as base64 PNG, given its bundle identifier.
//
// NSWorkspace is the only thing that answers for every application. Modern
// bundles ship their icon inside a compiled asset catalog with no .icns to
// read, so reaching into Contents/Resources finds nothing for them, while
// NSWorkspace returns the same icon the Dock and Finder draw.

let size = 64

// The settings picker needs installed applications, including apps that have
// not appeared in history yet. Reuse this native helper so the catalog and
// icon lookup agree on macOS bundle identifiers.
if CommandLine.arguments.dropFirst().first == "--list" {
  var applications: [String: String] = [:]

  // Finder and the Dock show localizedName ("钉钉"), not the English
  // CFBundleName ("DingTalk") that ships in the base Info.plist.
  func finderName(_ url: URL) -> String {
    if let localized = try? url.resourceValues(forKeys: [.localizedNameKey]).localizedName {
      let trimmed = localized.lowercased().hasSuffix(".app") ? String(localized.dropLast(4)) : localized
      if !trimmed.isEmpty { return trimmed }
    }
    if let bundle = Bundle(url: url) {
      let info = bundle.localizedInfoDictionary ?? bundle.infoDictionary ?? [:]
      if let name = (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String),
         !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return name
      }
    }
    return url.deletingPathExtension().lastPathComponent
  }

  func flagged(_ info: [String: Any], _ key: String) -> Bool {
    switch info[key] {
    case let value as Bool: return value
    case let value as NSNumber: return value.intValue != 0
    case let value as String: return value == "1" || value.lowercased() == "true"
    default: return false
    }
  }

  func add(_ url: URL, preferredName: String? = nil) {
    // Helpers live inside another .app (DingTalk ScreenShot Helper, crash
    // reporters). The user launches the outer application, not those bundles.
    if url.path.range(of: ".app/", options: [.caseInsensitive]) != nil { return }
    guard let bundle = Bundle(url: url), let identifier = bundle.bundleIdentifier,
          !identifier.isEmpty else { return }
    let info = bundle.localizedInfoDictionary ?? bundle.infoDictionary ?? [:]
    if flagged(info, "LSUIElement") || flagged(info, "LSBackgroundOnly") { return }
    let name = preferredName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolved = (name?.isEmpty == false ? name! : finderName(url))
    if resolved.isEmpty || applications[identifier] != nil { return }
    applications[identifier] = resolved
  }

  // Dock names first, so a running app's localizedName is not replaced by the
  // English bundle name discovered later in /Applications.
  for application in NSWorkspace.shared.runningApplications {
    if let url = application.bundleURL { add(url, preferredName: application.localizedName) }
  }
  let manager = FileManager.default
  for root in manager.urls(for: .applicationDirectory, in: .allDomainsMask) {
    guard let entries = manager.enumerator(at: root, includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles], errorHandler: nil) else { continue }
    for case let url as URL in entries where url.pathExtension == "app" {
      add(url)
      entries.skipDescendants()
    }
  }
  let rows = applications.map { ["bundleId": $0.key, "name": $0.value] }
    .sorted { $0["name"]!.localizedStandardCompare($1["name"]!) == .orderedAscending }
  guard let data = try? JSONSerialization.data(withJSONObject: rows),
        let text = String(data: data, encoding: .utf8) else { exit(4) }
  print(text)
  exit(0)
}

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
