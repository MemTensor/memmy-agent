import CoreGraphics
import Foundation

/// Screen Lock is a different macOS authorization boundary from Accessibility
/// and Screen Recording. The ordinary app agent must never operate loginwindow.
public enum LockScreenState: Equatable {
    case unlocked
    case locked
    case unavailable

    public static func current() -> LockScreenState {
        fromSession(CGSessionCopyCurrentDictionary() as? [String: Any])
    }

    static func fromSession(_ properties: [String: Any]?) -> LockScreenState {
        guard let properties else { return .unavailable }

        // CoreGraphics exposes the session dictionary, but this lock-state key
        // is not part of its documented stable property set. A positive lock
        // report is authoritative; missing session identity is not permission
        // to assume the desktop is available.
        if let locked = properties["CGSSessionScreenIsLocked"] as? Bool, locked {
            return .locked
        }
        let onConsole = (properties[kCGSessionOnConsoleKey as String] as? Bool)
            ?? (properties["kCGSSessionOnConsoleKey"] as? Bool)
        let loginDone = properties[kCGSessionLoginDoneKey as String] as? Bool
        guard onConsole == true, loginDone == true else { return .unavailable }
        return .unlocked
    }

    func requireUnlocked() throws {
        switch self {
        case .unlocked:
            return
        case .locked:
            throw ComputerUseError.stateUnavailable(
                "The Mac is locked. Unlock it manually before continuing Computer Use. No input was sent to the lock screen."
            )
        case .unavailable:
            throw ComputerUseError.stateUnavailable(
                "Computer Use could not verify an unlocked console session. No desktop action was sent."
            )
        }
    }
}
