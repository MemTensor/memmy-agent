#include "common/json.h"

#include <algorithm>
#include <vector>

namespace memmy {

std::string DumpJson(const Json& value) {
  return value.dump(-1, ' ', false, Json::error_handler_t::replace);
}

std::optional<Json> ParseJsonStrict(std::string_view text, std::size_t maxDepth) {
  std::vector<std::vector<std::string>> keys;
  bool rejected = false;
  const Json::parser_callback_t callback = [&](int depth, Json::parse_event_t event, Json& parsed) {
    if (depth < 0 || static_cast<std::size_t>(depth) > maxDepth) rejected = true;
    switch (event) {
      case Json::parse_event_t::object_start:
        keys.emplace_back();
        break;
      case Json::parse_event_t::object_end:
        if (!keys.empty()) keys.pop_back();
        break;
      case Json::parse_event_t::key: {
        if (keys.empty() || !parsed.is_string()) {
          rejected = true;
          break;
        }
        const auto& key = parsed.get_ref<const std::string&>();
        auto& seen = keys.back();
        if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
          rejected = true;
        } else {
          seen.push_back(key);
        }
        break;
      }
      default:
        break;
    }
    return true;
  };
  try {
    Json value = Json::parse(text.begin(), text.end(), callback, true, false);
    if (rejected) return std::nullopt;
    return value;
  } catch (const Json::exception&) {
    return std::nullopt;
  }
}

}  // namespace memmy
