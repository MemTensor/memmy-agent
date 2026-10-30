#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace memmy::text {

// UTF-16 to UTF-8. Unpaired surrogates become U+FFFD so the result is always valid UTF-8.
std::string ToUtf8(std::wstring_view value);

// Strict UTF-8 to UTF-16. Rejects overlong forms, surrogate code points and truncated sequences.
std::optional<std::wstring> FromUtf8(std::string_view value);

// Number of UTF-16 code units the UTF-8 text decodes to (the unit used by text budgets and
// by JavaScript string length). Returns nullopt for invalid UTF-8.
std::optional<std::size_t> Utf16Length(std::string_view utf8);

// Prefix of at most maxUnits UTF-16 code units that never splits a surrogate pair.
std::wstring_view TruncateUtf16(std::wstring_view value, std::size_t maxUnits);

// Strict unsigned decimal: ASCII digits only, no sign, whitespace or redundant leading zero,
// and no overflow. Used for identity fields that must not pass through floating point.
std::optional<std::uint64_t> ParseUnsignedDecimal(std::string_view value);
std::optional<std::uint64_t> ParseUnsignedDecimal(std::wstring_view value);

// Ordinal, case-insensitive comparison with the same upper-casing NTFS uses for paths.
bool EqualsOrdinalIgnoreCase(std::wstring_view left, std::wstring_view right);

std::string ToLowerHex(const unsigned char* data, std::size_t size);

}  // namespace memmy::text
