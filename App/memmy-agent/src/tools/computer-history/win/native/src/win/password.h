#pragma once

#include <windows.h>

#include <cstdint>
#include <optional>

namespace memmy::win {

// Metadata only. nullopt means the HWND/owner/class/style could not be verified.
std::optional<bool> NativePasswordState(HWND hwnd, std::uint32_t expectedPid);

// Native evidence may strengthen a provider assertion, never weaken it.
std::optional<bool> EffectivePasswordState(std::optional<bool> provider, std::optional<bool> native);

}  // namespace memmy::win
