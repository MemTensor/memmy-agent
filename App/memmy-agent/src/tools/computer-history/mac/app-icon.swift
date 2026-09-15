import AppKit
import Foundation

// Prints one application's icon as base64 PNG, given its bundle identifier.
//
// NSWorkspace is the only thing that answers for every application. Modern
// bundles ship their icon inside a compiled asset catalog with no .icns to
// read, so reaching into Contents/Resources finds nothing for them, while
// NSWorkspace returns the same icon the Dock and Finder draw.

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
