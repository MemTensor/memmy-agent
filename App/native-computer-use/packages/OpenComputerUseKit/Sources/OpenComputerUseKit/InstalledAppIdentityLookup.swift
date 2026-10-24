import Foundation

struct InstalledAppIdentity {
    let url: URL
    let appId: String
    let displayName: String
    let names: Set<String>
}

struct InstalledAppIdentityResolution {
    enum Status: String { case resolved, notFound = "not-found", ambiguous, blocked, unavailable }
    let status: Status
    let app: InstalledAppIdentity?

    func jsonText() throws -> String {
        var object: [String: Any] = ["platform": "darwin", "status": status.rawValue]
        if let app, status == .resolved {
            object["app"] = ["appId": app.appId, "displayName": app.displayName]
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}

/// This scan reads installed bundles only. It never queries AX/TCC, launches an
/// app, or depends on Spotlight's recent-use catalog.
enum InstalledAppIdentityLookup {
    static func resolve(_ query: String, roots: [URL] = AppDiscovery.standardApplicationSearchRoots,
                        maxVisitedEntries: Int = 100_000, maxDuration: TimeInterval = 3,
                        clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) -> InstalledAppIdentityResolution {
        let wanted = normalized(query)
        guard !wanted.isEmpty, query.count <= 256, !query.contains("\0") else {
            return InstalledAppIdentityResolution(status: .notFound, app: nil)
        }
        let wantedName = wanted.hasSuffix(".app") ? String(wanted.dropLast(4)) : wanted
        let start = clock()
        var visited = 0
        var seenPaths: Set<String> = []
        var matches: [InstalledAppIdentity] = []
        let manager = FileManager.default
        for root in roots {
            let rootPath = root.resolvingSymlinksInPath().standardizedFileURL.path
            var isDirectory: ObjCBool = false
            guard manager.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
            var scanFailed = false
            guard let enumerator = manager.enumerator(at: root,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants],
                errorHandler: { _, _ in scanFailed = true; return false }) else {
                return InstalledAppIdentityResolution(status: .unavailable, app: nil)
            }
            for case let url as URL in enumerator {
                visited += 1
                guard visited <= maxVisitedEntries, clock() - start < maxDuration else {
                    return InstalledAppIdentityResolution(status: .unavailable, app: nil)
                }
                if url.pathExtension.caseInsensitiveCompare("app") == .orderedSame {
                    // Do not inspect nested helper bundles inside an application.
                    enumerator.skipDescendants()
                    let canonical = url.resolvingSymlinksInPath().standardizedFileURL
                    guard canonical.path.hasPrefix(rootPath + "/"), seenPaths.insert(canonical.path).inserted,
                          let app = identity(at: canonical) else { continue }
                    if normalized(app.appId) == wanted || app.names.contains(wantedName) { matches.append(app) }
                } else if (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                    enumerator.skipDescendants()
                }
            }
            // An incomplete scan must not turn a partial match into a unique identity.
            if scanFailed { return InstalledAppIdentityResolution(status: .unavailable, app: nil) }
        }
        guard matches.count == 1, let app = matches.first else {
            return InstalledAppIdentityResolution(status: matches.isEmpty ? .notFound : .ambiguous, app: nil)
        }
        guard !AppSafetyPolicy.isBlocked(bundleIdentifier: app.appId) else {
            return InstalledAppIdentityResolution(status: .blocked, app: nil)
        }
        return InstalledAppIdentityResolution(status: .resolved, app: app)
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func identity(at url: URL) -> InstalledAppIdentity? {
        guard let bundle = Bundle(url: url),
              let appId = bundle.bundleIdentifier,
              appId.range(of: #"^[A-Za-z0-9_.!-]{1,256}$"#, options: .regularExpression) != nil,
              bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool != true,
              bundle.object(forInfoDictionaryKey: "LSUIElement") as? Bool != true else { return nil }
        let fileName = url.deletingPathExtension().lastPathComponent
        let displayName = AppDiscovery.bundleDisplayName(bundle) ?? fileName
        guard !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              displayName.count <= 256 else { return nil }
        var names = [fileName, displayName]
        if let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String { names.append(name) }
        for key in ["CFBundleName", "CFBundleDisplayName"] {
            if let name = bundle.infoDictionary?[key] as? String { names.append(name) }
        }
        names.append(contentsOf: localizedNames(in: bundle))
        // The bundle's executable name is read from metadata; no process starts.
        if let name = bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String { names.append(name) }
        return InstalledAppIdentity(url: url, appId: appId, displayName: displayName,
                                    names: Set(names.map(normalized).filter { !$0.isEmpty }))
    }

    private static func localizedNames(in bundle: Bundle) -> [String] {
        guard let resources = bundle.resourceURL else { return [] }
        var names: [String] = []
        let table = resources.appendingPathComponent("InfoPlist.loctable")
        if let languages = metadataDictionary(at: table), languages.count <= 256 {
            for case let entry as [String: Any] in languages.values {
                names.append(contentsOf: nameValues(in: entry))
            }
        }
        // Older bundles store the same metadata in per-language InfoPlist.strings.
        for language in bundle.localizations.prefix(256) {
            guard !language.contains("/"), language != ".", language != ".." else { continue }
            let file = resources.appendingPathComponent(language + ".lproj", isDirectory: true)
                .appendingPathComponent("InfoPlist.strings")
            if let entry = metadataDictionary(at: file) { names.append(contentsOf: nameValues(in: entry)) }
        }
        return names
    }

    private static func metadataDictionary(at url: URL) -> [String: Any]? {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 128 * 1024,
              let data = try? Data(contentsOf: url),
              let value = try? PropertyListSerialization.propertyList(from: data, format: nil) else { return nil }
        return value as? [String: Any]
    }

    private static func nameValues(in dictionary: [String: Any]) -> [String] {
        ["CFBundleDisplayName", "CFBundleName"].compactMap { key in
            guard let name = dictionary[key] as? String, !name.isEmpty, name.count <= 256 else { return nil }
            return name
        }
    }
}

public func resolveInstalledAppIdentityJSON(query: String) throws -> String {
    try InstalledAppIdentityLookup.resolve(query).jsonText()
}
