import Foundation

@main enum IdentityTests {
    static func main() {
        let app = URL(fileURLWithPath: "/Applications/Memmy.app/Contents/Helpers/Open Computer Use.app")
        let old: [String: Any] = ["bundleURL": app.path,
            "processStartTime": Date().addingTimeInterval(60).timeIntervalSince1970,
            "buildIdentifier": "previous-build"]
        precondition(!appAgentIdentityMatches(old, appURL: app, buildIdentifier: "current-build"), "Old helper with a recent lazy timestamp must be rejected")
        precondition(!appAgentIdentityMatches(["bundleURL": app.path], appURL: app, buildIdentifier: "current-build"), "Unversioned helper must be rejected")
        let current: [String: Any] = ["bundleURL": app.path, "buildIdentifier": "current-build"]
        precondition(appAgentIdentityMatches(current, appURL: app, buildIdentifier: "current-build"), "Matching helper must be accepted")
        precondition(!appAgentIdentityMatches(current, appURL: URL(fileURLWithPath: "/Applications/Other.app"), buildIdentifier: "current-build"), "Different bundle must be rejected")
        print("4 native identity checks passed")
    }
}
