#pragma once

#include "common/protocol.h"

#include <windows.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace memmy::win {

inline HWND ToHwnd(std::uint64_t value) { return reinterpret_cast<HWND>(static_cast<std::uintptr_t>(value)); }
inline std::uint64_t FromHwnd(HWND hwnd) { return static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(hwnd)); }

// Final, normalized DOS path (symlinks, 8.3 names and case resolved) when the file can be
// opened; otherwise the fully qualified input. Never trusted alone: identity also needs PID and
// process creation time.
std::wstring CanonicalizePath(const std::wstring& path);

// Reads the instance identity of a top-level window: real owning PID (from the HWND, not
// MainWindowHandle), process creation FILETIME, canonical image path, DPI and bounds.
// Returns nullopt with a protocol reason when any part is unavailable.
std::optional<protocol::ContextRecord> ReadWindowContext(std::uint64_t hwnd, std::string& reason);

std::uint64_t ForegroundWindow();

// Title without sending messages to the target (InternalGetWindowText), bounded.
std::string ReadWindowTitle(std::uint64_t hwnd, std::size_t maxUnits);

std::vector<std::uint64_t> VisibleTopLevelWindows(std::uint32_t pid);

std::optional<std::uint64_t> ProcessCreationTime(HANDLE process);

policy::Target ToTarget(const protocol::ContextRecord& context);

}  // namespace memmy::win
