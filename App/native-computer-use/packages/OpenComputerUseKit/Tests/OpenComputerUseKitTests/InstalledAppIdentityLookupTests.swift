import Foundation
import XCTest
@testable import MemmyComputerUseKit

final class InstalledAppIdentityLookupTests: XCTestCase {
    private var roots: [URL] = []
    override func tearDownWithError() throws {
        for root in roots { try FileManager.default.removeItem(at: root) }
        roots = []
    }

    private func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("memmy-installed-identity-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        roots.append(root)
        return root
    }

    @discardableResult
    private func application(in root: URL, fileName: String, id: String, displayName: String,
                             flags: [String: Any] = [:]) throws -> URL {
        let app = root.appendingPathComponent(fileName + ".app", isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let dictionary = ["CFBundlePackageType": "APPL", "CFBundleIdentifier": id,
                          "CFBundleName": fileName, "CFBundleDisplayName": displayName,
                          "CFBundleExecutable": fileName].merging(flags) { _, rhs in rhs }
        try PropertyListSerialization.data(fromPropertyList: dictionary, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        return app
    }

    func testReadsInstalledAppWithoutRunningProcessSpotlightOrRecentTenLimit() throws {
        let root = try temporaryRoot()
        for i in 0..<15 {
            try application(in: root, fileName: "Ordinary\(i)", id: "example.ordinary\(i)", displayName: "Ordinary\(i)")
        }
        let app = try application(in: root, fileName: "Unopened", id: "example.unopened", displayName: "未打开应用")
        // Only on-disk metadata exists. There is no executable to launch and no
        // running/last-used data; finding the sixteenth app cannot use recent10.
        for query in ["Unopened", "未打开应用", "example.unopened", "Unopened.app"] {
            let result = InstalledAppIdentityLookup.resolve(query, roots: [root])
            XCTAssertEqual(result.status, .resolved)
            XCTAssertEqual(result.app?.appId, "example.unopened")
            XCTAssertEqual(result.app?.url, app)
        }
    }

    func testUsesBundleLocalizedNamesAndNeverBundleSuffixGuesses() throws {
        let root = try temporaryRoot()
        let app = try application(in: root, fileName: "EnglishName", id: "example.unrelated", displayName: "EnglishName")
        let resources = app.appendingPathComponent("Contents/Resources", isDirectory: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["zh_CN": ["CFBundleDisplayName": "中文名字"]], format: .binary, options: 0)
            .write(to: resources.appendingPathComponent("InfoPlist.loctable"))
        let localized = resources.appendingPathComponent("de.lproj", isDirectory: true)
        try FileManager.default.createDirectory(at: localized, withIntermediateDirectories: true)
        try Data(#""CFBundleDisplayName" = "Deutscher Name";"#.utf8).write(to: localized.appendingPathComponent("InfoPlist.strings"))
        for query in ["EnglishName", "中文名字", "Deutscher Name", "example.unrelated"] {
            XCTAssertEqual(InstalledAppIdentityLookup.resolve(query, roots: [root]).app?.appId, "example.unrelated")
        }
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("unrelated", roots: [root]).status, .notFound)
    }

    func testRejectsMultipleInstallationsEvenWhenTheirBundleIdentifiersMatch() throws {
        let root = try temporaryRoot()
        try application(in: root, fileName: "First", id: "example.same", displayName: "Same")
        try application(in: root, fileName: "Second", id: "example.same", displayName: "Same")
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Same", roots: [root]).status, .ambiguous)
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("example.same", roots: [root]).status, .ambiguous)
        XCTAssertNil(AppDiscovery.applicationURL(named: "example.same", roots: [root]))
    }

    func testLaunchSelectionUsesTheVerifiedInstalledPathForNamesAndBundleIDs() throws {
        let root = try temporaryRoot()
        let app = try application(in: root, fileName: "Unopened", id: "example.unopened", displayName: "未打开应用")
        for query in ["Unopened", "未打开应用", "example.unopened"] {
            XCTAssertEqual(AppDiscovery.applicationURL(named: query, roots: [root]), app)
        }
        XCTAssertNil(AppDiscovery.applicationURL(named: "example.missing", roots: [root]))
        try application(in: root, fileName: "Password", id: "com.lastpass.LastPass", displayName: "Password")
        XCTAssertNil(AppDiscovery.applicationURL(named: "Password", roots: [root]))
    }

    func testRejectsDifferentAppsSharingAName() throws {
        let root = try temporaryRoot()
        try application(in: root, fileName: "First", id: "example.first", displayName: "Same")
        try application(in: root, fileName: "Second", id: "example.second", displayName: "Same")
        let result = InstalledAppIdentityLookup.resolve("Same", roots: [root])
        XCTAssertEqual(result.status, .ambiguous)
        XCTAssertNil(result.app)
    }

    func testDeduplicatesOverlappingRootsAndSymlinksToTheSameInstallation() throws {
        let root = try temporaryRoot()
        let app = try application(in: root, fileName: "Ordinary", id: "example.ordinary", displayName: "Ordinary")
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Alias.app"), withDestinationURL: app)
        let result = InstalledAppIdentityLookup.resolve("example.ordinary", roots: [root, root])
        XCTAssertEqual(result.status, .resolved)
        XCTAssertEqual(result.app?.url, app)
    }

    func testDoesNotFollowAliasesOutsideApprovedRootsOrNestedHelpers() throws {
        let root = try temporaryRoot(), outside = try temporaryRoot()
        let app = try application(in: outside, fileName: "Outside", id: "example.outside", displayName: "Outside")
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Outside.app"), withDestinationURL: app)
        let parent = try application(in: root, fileName: "Parent", id: "example.parent", displayName: "Parent")
        try application(in: parent.appendingPathComponent("Contents"), fileName: "Nested", id: "example.nested", displayName: "Nested")
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Outside", roots: [root]).status, .notFound)
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Nested", roots: [root]).status, .notFound)
    }

    func testRejectsBackgroundUIElementInvalidAndSafetyBlockedBundles() throws {
        let root = try temporaryRoot()
        try application(in: root, fileName: "Background", id: "example.background", displayName: "Background", flags: ["LSBackgroundOnly": true])
        try application(in: root, fileName: "UIElement", id: "example.uielement", displayName: "UIElement", flags: ["LSUIElement": true])
        try application(in: root, fileName: "Invalid", id: "../invalid", displayName: "Invalid")
        try application(in: root, fileName: "Password", id: "COM.LASTPASS.LASTPASS", displayName: "Password")
        try application(in: root, fileName: "Passwords", id: "com.apple.Passwords", displayName: "密码",
                         flags: ["CFBundlePackageType": "XPC!"])
        for query in ["Background", "UIElement", "Invalid"] {
            XCTAssertEqual(InstalledAppIdentityLookup.resolve(query, roots: [root]).status, .notFound)
        }
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Password", roots: [root]).status, .blocked)
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("密码", roots: [root]).status, .blocked)
    }

    func testPackageTypeDoesNotDecideWhetherABundleIsAnApp() throws {
        let root = try temporaryRoot()
        try application(in: root, fileName: "Finder", id: "example.finder", displayName: "Finder", flags: ["CFBundlePackageType": "FNDR"])
        try application(in: root, fileName: "Untyped", id: "example.untyped", displayName: "Untyped", flags: ["CFBundlePackageType": ""])
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Finder", roots: [root]).app?.appId, "example.finder")
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Untyped", roots: [root]).app?.appId, "example.untyped")
    }

    func testIncompleteScansCannotDeclarePartialMatchUnique() throws {
        let root = try temporaryRoot()
        try application(in: root, fileName: "First", id: "example.first", displayName: "Same")
        try application(in: root, fileName: "Second", id: "example.second", displayName: "Same")
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Same", roots: [root], maxVisitedEntries: 1).status, .unavailable)
        var time: TimeInterval = 0
        XCTAssertEqual(InstalledAppIdentityLookup.resolve("Same", roots: [root], clock: { time += 4; return time }).status, .unavailable)
    }

    func testReadOnlyCLIStaysOutsideAppAgentAndPublicToolSet() throws {
        XCTAssertEqual(try parseOpenComputerUseCLI(arguments: ["resolve-app", "--query", "计算器"]), .resolveApp(query: "计算器"))
        XCTAssertFalse(shouldUseMacOSAppAgentProxy(command: .resolveApp(query: "Calculator"),
            proxyDisabled: false, appBundleAvailable: true, runningFromLaunchServicesAppInstance: false))
        for args in [["resolve-app"], ["resolve-app", "Calculator"], ["resolve-app", "--query", ""],
                     ["resolve-app", "--query", "Same", "--launch"]] {
            XCTAssertThrowsError(try parseOpenComputerUseCLI(arguments: args))
        }
        XCTAssertEqual(ToolDefinitions.all.count, 9)
        XCTAssertFalse(ToolDefinitions.all.contains { $0.name == "resolve_app" })
        let json = try InstalledAppIdentityResolution(status: .ambiguous, app: nil).jsonText()
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String])
        XCTAssertEqual(parsed, ["platform": "darwin", "status": "ambiguous"])
    }

    func testSystemCalculatorIdentityIsReadFromItsInstalledBundleWithoutLaunch() throws {
        guard FileManager.default.fileExists(atPath: "/System/Applications/Calculator.app") else {
            throw XCTSkip("System Calculator is not installed")
        }
        for query in ["Calculator", "计算器", "com.apple.calculator"] {
            let result = InstalledAppIdentityLookup.resolve(query)
            XCTAssertEqual(result.status, .resolved, query)
            XCTAssertEqual(result.app?.appId, "com.apple.calculator", query)
            XCTAssertEqual(result.app?.url.path, "/System/Applications/Calculator.app", query)
        }
    }

    func testSystemFinderIdentityResolvesFromCoreServices() throws {
        guard FileManager.default.fileExists(atPath: "/System/Library/CoreServices/Finder.app") else {
            throw XCTSkip("System Finder is not installed")
        }
        for query in ["Finder", "访达", "com.apple.finder"] {
            let result = InstalledAppIdentityLookup.resolve(query)
            XCTAssertEqual(result.status, .resolved, query)
            XCTAssertEqual(result.app?.appId, "com.apple.finder", query)
            XCTAssertEqual(result.app?.url.path, "/System/Library/CoreServices/Finder.app", query)
        }
    }
}
