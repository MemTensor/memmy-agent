#pragma once

#include <nlohmann/json.hpp>

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace memmy {

// Insertion-ordered so protocol lines read envelope-first; key order carries no meaning.
using Json = nlohmann::ordered_json;

// Compact single-line UTF-8 serialization. Non-ASCII is emitted as UTF-8 (not \u escapes);
// invalid UTF-8 is replaced with U+FFFD instead of throwing.
std::string DumpJson(const Json& value);

// Strict parse: RFC 8259 JSON only (no comments), valid UTF-8, no duplicate object keys,
// bounded nesting. Returns nullopt on any violation without echoing the input.
std::optional<Json> ParseJsonStrict(std::string_view text, std::size_t maxDepth);

}  // namespace memmy
