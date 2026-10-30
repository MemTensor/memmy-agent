#pragma once
#include <string>
#include <string_view>

namespace memmy::browser {
enum class Kind { None, Chrome, Edge };
const char* Name(Kind kind);
Kind FromName(std::string_view name);
bool MatchesExecutable(Kind kind, std::wstring_view path);
// Positive evidence is deliberately limited to recognized normal-profile labels.
// Unknown/localized/custom labels fail closed; absence of an incognito label is not evidence.
bool NormalProfile(std::wstring_view name, std::wstring_view id, std::wstring_view className, Kind kind = Kind::Chrome);
bool PrivateSignal(std::wstring_view value);
bool AddressControl(std::wstring_view name, std::wstring_view id);
std::wstring SanitizeUrl(std::wstring_view raw);
bool AddressMatches(std::wstring_view address, std::wstring_view committed);
}  // namespace memmy::browser
