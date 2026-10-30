#include "common/protocol.h"

#include "common/classify.h"
#include "common/text.h"

#include <algorithm>
#include <cstdio>
#include <set>

namespace memmy::protocol {
namespace {

constexpr std::string_view kReasons[] = {
    "policy_unavailable", "policy_invalid", "policy_changed", "policy_too_large",
    "application_denied", "application_not_authorized", "browser_unsupported",
    "window_unavailable", "not_top_level", "process_unavailable", "identity_unavailable",
    "not_foreground", "context_changed", "paused",
    "uia_unavailable", "uia_root_unavailable", "uia_root_mismatch", "uia_error",
    "worker_timeout", "worker_failed", "worker_job_failed", "worker_launch_failed",
    "worker_invalid_output", "worker_output_too_large", "worker_invalid_request",
    "hook_barrier_failed", "test_gate_failed", "test_gate_timeout",
    "collector_shutdown", "out_of_memory", "internal_error", "com_unavailable",
    "uia_timeout", "foreign_root", "query_budget_exhausted", "worker_privacy_violation"};

constexpr std::array<std::string_view, 6> kTruncations = {"max_nodes", "max_visited", "max_depth",
                                                          "max_text", "budget_ms", "traversal_error"};

constexpr std::array<std::string_view, 7> kMissing = {"name", "text", "visibleText", "value",
                                                      "bounds", "runtimeId", "automationId"};

void Fnv(std::uint64_t& hash, std::string_view data) {
  for (const char c : data) {
    hash ^= static_cast<unsigned char>(c);
    hash *= 1099511628211ull;
  }
  hash ^= 0x1F;
  hash *= 1099511628211ull;
}

void FnvOptional(std::uint64_t& hash, const std::optional<std::string>& value) {
  Fnv(hash, value ? std::string_view("1") : std::string_view("0"));
  Fnv(hash, value ? std::string_view(*value) : std::string_view());
}

std::string Decimal(std::uint64_t value) { return std::to_string(value); }

bool GetString(const Json& object, const char* key, std::size_t maxBytes, std::string& out) {
  const auto it = object.find(key);
  if (it == object.end() || !it->is_string()) return false;
  const auto& value = it->get_ref<const std::string&>();
  if (value.size() > maxBytes || !text::Utf16Length(value)) return false;
  out = value;
  return true;
}

bool GetDecimal(const Json& object, const char* key, std::uint64_t& out) {
  const auto it = object.find(key);
  if (it == object.end() || !it->is_string()) return false;
  const auto parsed = text::ParseUnsignedDecimal(std::string_view(it->get_ref<const std::string&>()));
  if (!parsed) return false;
  out = *parsed;
  return true;
}

bool GetUnsigned(const Json& object, const char* key, std::uint64_t max, std::uint64_t& out) {
  const auto it = object.find(key);
  // Integers only (parsed JSON yields unsigned; in-memory values may be signed and >= 0).
  if (it == object.end() || !it->is_number_integer()) return false;
  if (!it->is_number_unsigned() && it->get<std::int64_t>() < 0) return false;
  out = it->get<std::uint64_t>();
  return out <= max;
}

bool OnlyKeys(const Json& object, std::initializer_list<std::string_view> allowed) {
  if (!object.is_object()) return false;
  for (const auto& item : object.items()) {
    if (std::find(allowed.begin(), allowed.end(), item.key()) == allowed.end()) return false;
  }
  return true;
}

bool ContextFromJson(const Json& json, ContextRecord& out) {
  if (!OnlyKeys(json, {"hwnd", "pid", "processStart", "executable", "dpi", "bounds", "minimized", "title"})) {
    return false;
  }
  std::uint64_t pid = 0;
  std::uint64_t dpi = 0;
  if (!GetDecimal(json, "hwnd", out.hwnd) || !GetUnsigned(json, "pid", 0xFFFFFFFFull, pid) ||
      !GetDecimal(json, "processStart", out.processStart) || !GetString(json, "executable", 65536, out.executable) ||
      !GetUnsigned(json, "dpi", 10000, dpi)) {
    return false;
  }
  out.pid = static_cast<std::uint32_t>(pid);
  out.dpi = static_cast<std::uint32_t>(dpi);
  const auto bounds = json.find("bounds");
  if (bounds == json.end() || !OnlyKeys(*bounds, {"left", "top", "right", "bottom"})) return false;
  const char* names[4] = {"left", "top", "right", "bottom"};
  for (int i = 0; i < 4; ++i) {
    const auto value = bounds->find(names[i]);
    if (value == bounds->end() || !value->is_number_integer()) return false;
    const auto number = value->get<std::int64_t>();
    if (number < INT32_MIN || number > INT32_MAX) return false;
    out.bounds[static_cast<std::size_t>(i)] = static_cast<std::int32_t>(number);
  }
  const auto minimized = json.find("minimized");
  if (minimized == json.end() || !minimized->is_boolean()) return false;
  out.minimized = minimized->get<bool>();
  if (json.contains("title")) {
    std::string title;
    if (!GetString(json, "title", 8192, title)) return false;
    out.title = std::move(title);
  }
  return true;
}

bool NodeFromJson(const Json& json, NodeRecord& node) {
  if (!OnlyKeys(json, {"runtimeId", "controlType", "automationId", "depth", "parent", "focused",
                       "providerOffscreen", "password", "redaction", "name", "text", "visibleText", "value",
                       "bounds", "missing", "documentStatus", "className"})) {
    return false;
  }
  std::string controlType;
  std::uint64_t depth = 0;
  if (!GetString(json, "runtimeId", 512, node.runtimeId) || !GetString(json, "controlType", 64, controlType) ||
      !GetString(json, "automationId", 1024, node.automationId) || !GetUnsigned(json, "depth", 64, depth)) {
    return false;
  }
  const auto type = classify::ControlTypeFromName(controlType);
  if (!type) return false;
  node.controlType = *type;
  node.depth = static_cast<int>(depth);
  if (json.contains("className")) {
    std::string value;
    if (!GetString(json, "className", 256, value)) return false;
    node.className = std::move(value);
  }
  const auto parent = json.find("parent");
  if (parent == json.end() || !parent->is_number_integer()) return false;
  const auto parentIndex = parent->get<std::int64_t>();
  if (parentIndex < -1 || parentIndex > 100000) return false;
  node.parent = static_cast<int>(parentIndex);
  const auto focused = json.find("focused");
  const auto offscreen = json.find("providerOffscreen");
  const auto password = json.find("password");
  if (focused == json.end() || !focused->is_boolean() || offscreen == json.end() || !offscreen->is_boolean() ||
      password == json.end() || !(password->is_boolean() || password->is_null())) {
    return false;
  }
  node.focused = focused->get<bool>();
  node.providerOffscreen = offscreen->get<bool>();
  if (password->is_boolean()) node.password = password->get<bool>();
  if (json.contains("redaction")) {
    if (!GetString(json, "redaction", 64, node.redaction) || !classify::RedactionFromCode(node.redaction)) return false;
  }
  if (json.contains("documentStatus")) {
    if (!GetString(json, "documentStatus", 32, node.documentStatus) ||
        (node.documentStatus != "available" && node.documentStatus != "label_only" && node.documentStatus != "read_failed")) return false;
  }
  for (auto [key, field] : {std::pair{"name", &node.name}, std::pair{"text", &node.text},
                            std::pair{"visibleText", &node.visibleText}, std::pair{"value", &node.value}}) {
    if (!json.contains(key)) continue;
    std::string value;
    if (!GetString(json, key, 1024 * 1024, value)) return false;
    *field = std::move(value);
  }
  if (json.contains("bounds")) {
    const Json& bounds = json["bounds"];
    if (!bounds.is_array() || bounds.size() != 4) return false;
    std::array<double, 4> values{};
    for (std::size_t i = 0; i < 4; ++i) {
      if (!bounds[i].is_number()) return false;
      values[i] = bounds[i].get<double>();
    }
    node.bounds = values;
  }
  if (json.contains("missing")) {
    const Json& missing = json["missing"];
    if (!missing.is_array() || missing.size() > kMissing.size()) return false;
    for (const auto& item : missing) {
      if (!item.is_string()) return false;
      const auto& name = item.get_ref<const std::string&>();
      if (std::find(kMissing.begin(), kMissing.end(), name) == kMissing.end()) return false;
      node.missing.push_back(name);
    }
  }
  return true;
}

classify::NodeDecision Recheck(const NodeRecord& node, const policy::Policy& policy, const policy::AppRule& rule,
                               bool patternsAvailable, bool scopedDocument) {
  const std::wstring automationId = text::FromUtf8(node.automationId).value_or(L"");
  classify::NodeFacts facts;
  facts.controlType = node.controlType;
  facts.password = !node.password ? classify::PasswordState::Unknown
                   : *node.password ? classify::PasswordState::True
                                    : classify::PasswordState::False;
  facts.automationId = automationId;
  facts.hasKeyboardFocus = node.focused;
  facts.textPatternAvailable = patternsAvailable;
  facts.valuePatternAvailable = patternsAvailable;
  facts.scopedDocument = scopedDocument;
  return classify::Classify(facts, policy, rule);
}

}  // namespace

bool IsVsCodeEditorBody(const NodeRecord& node, const std::vector<NodeRecord>& preceding, const policy::AppRule& rule) {
  const auto knownId = [](const NodeRecord& item) {
    return std::find(item.missing.begin(), item.missing.end(), "automationId") == item.missing.end();
  };
  if (node.controlType != classify::kEdit || !policy::HasVsCodeEditorScope(rule) || !node.automationId.empty() ||
      node.password != false || !knownId(node)) return false;
  int parent = node.parent;
  int depth = node.depth;
  const std::array<long, 3> types = {classify::kText, classify::kGroup, classify::kGroup};
  for (std::size_t i = 0; i < types.size(); ++i) {
    if (parent < 0 || static_cast<std::size_t>(parent) >= preceding.size()) return false;
    const auto& ancestor = preceding[static_cast<std::size_t>(parent)];
    if (ancestor.controlType != types[i] || ancestor.automationId != (i == 2 ? "workbench.parts.editor" : "") ||
        ancestor.password != false || !ancestor.redaction.empty() || !knownId(ancestor) || ancestor.depth != --depth) return false;
    parent = ancestor.parent;
  }
  return true;
}

void FinalizeScopedDocument(NodeRecord& node) {
  const auto trim = [](const std::string& text) -> std::string_view {
    const auto start = text.find_first_not_of(" \r\n\t");
    if (start == std::string::npos) return {};
    return std::string_view(text).substr(start, text.find_last_not_of(" \r\n\t") - start + 1);
  };
  node.documentStatus = !node.name || !node.text ? "read_failed"
    : !trim(*node.name).empty() && trim(*node.name) == trim(*node.text) ? "label_only" : "available";
  if (node.documentStatus != "available") {
    node.name.reset(); node.text.reset(); node.visibleText.reset(); node.value.reset();
    node.redaction = "edit_control";
  }
}

bool IsWordDocument(const NodeRecord& node, const std::vector<NodeRecord>& preceding, const policy::AppRule& rule) {
  if (node.controlType != classify::kDocument || !policy::HasWordDocumentScope(rule)) return false;
  const std::array<long, 4> types = {classify::kDocument, classify::kPane, classify::kPane, classify::kWindow};
  const std::array<std::string_view, 4> classes = {"_WwG", "_WwB", "_WwF", "OpusApp"};
  const NodeRecord* current = &node;
  for (int i = 0; i < 4; ++i) {
    if (current->controlType != types[i] || current->className != classes[i] || !current->automationId.empty() ||
        current->depth != 3 - i || current->password != false || (i > 0 && !current->redaction.empty()) ||
        std::find(current->missing.begin(), current->missing.end(), "automationId") != current->missing.end()) return false;
    if (i == 3) return current->parent == -1;
    if (current->parent < 0 || static_cast<std::size_t>(current->parent) >= preceding.size()) return false;
    current = &preceding[static_cast<std::size_t>(current->parent)];
  }
  return false;
}

bool IsNotepadDocument(const NodeRecord& node, const std::vector<NodeRecord>& preceding, const policy::AppRule& rule) {
  if (node.controlType != classify::kDocument || !policy::HasNotepadDocumentScope(rule)) return false;
  const std::array<long, 3> types = {classify::kDocument, classify::kPane, classify::kWindow};
  const std::array<std::string_view, 3> classes = {"RichEditD2DPT", "NotepadTextBox", "Notepad"};
  const NodeRecord* current = &node;
  for (int i = 0; i < 3; ++i) {
    if (current->controlType != types[i] || current->className != classes[i] || !current->automationId.empty() ||
        current->depth != 2 - i || current->password != false || (i > 0 && !current->redaction.empty()) ||
        std::find(current->missing.begin(), current->missing.end(), "automationId") != current->missing.end()) return false;
    if (i == 2) return current->parent == -1;
    if (current->parent < 0 || static_cast<std::size_t>(current->parent) >= preceding.size()) return false;
    current = &preceding[static_cast<std::size_t>(current->parent)];
  }
  return false;
}

std::string FormatUtcTimestamp(std::uint64_t filetimeTicks) {
  // FILETIME epoch 1601-01-01 is 134774 days before 1970-01-01.
  const std::uint64_t totalMs = filetimeTicks / 10000;
  const std::int64_t unixMs = static_cast<std::int64_t>(totalMs) - 11644473600000ll;
  std::int64_t days = unixMs >= 0 ? unixMs / 86400000 : (unixMs - 86399999) / 86400000;
  std::int64_t msOfDay = unixMs - days * 86400000;
  // Howard Hinnant's civil_from_days.
  days += 719468;
  const std::int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const std::int64_t doe = days - era * 146097;
  const std::int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  std::int64_t year = yoe + era * 400;
  const std::int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const std::int64_t mp = (5 * doy + 2) / 153;
  const std::int64_t day = doy - (153 * mp + 2) / 5 + 1;
  const std::int64_t month = mp < 10 ? mp + 3 : mp - 9;
  if (month <= 2) ++year;
  char buffer[40];
  std::snprintf(buffer, sizeof(buffer), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%03lldZ",
                static_cast<long long>(year), static_cast<long long>(month), static_cast<long long>(day),
                static_cast<long long>(msOfDay / 3600000), static_cast<long long>((msOfDay / 60000) % 60),
                static_cast<long long>((msOfDay / 1000) % 60), static_cast<long long>(msOfDay % 1000));
  return buffer;
}

bool IsKnownReason(std::string_view reason) {
  return std::find(std::begin(kReasons), std::end(kReasons), reason) != std::end(kReasons);
}

std::string NodeKey(const NodeRecord& node, std::string_view parentKey) {
  std::uint64_t hash = 14695981039346656037ull;
  Fnv(hash, node.runtimeId);
  Fnv(hash, std::to_string(node.controlType));
  Fnv(hash, node.automationId);
  if (node.className) Fnv(hash, *node.className);
  Fnv(hash, node.redaction);
  if (!node.documentStatus.empty()) Fnv(hash, node.documentStatus);
  Fnv(hash, node.password ? (*node.password ? "1" : "0") : "-");
  Fnv(hash, node.focused ? "1" : "0");
  Fnv(hash, node.providerOffscreen ? "1" : "0");
  FnvOptional(hash, node.name);
  FnvOptional(hash, node.text);
  FnvOptional(hash, node.visibleText);
  FnvOptional(hash, node.value);
  Fnv(hash, parentKey);
  char buffer[17];
  std::snprintf(buffer, sizeof(buffer), "%016llx", static_cast<unsigned long long>(hash));
  return buffer;
}

std::vector<std::string> NodeKeys(const std::vector<NodeRecord>& nodes) {
  std::vector<std::string> keys;
  keys.reserve(nodes.size());
  std::set<std::string> used;
  for (const auto& node : nodes) {
    const std::string parent = node.parent >= 0 ? keys.at(static_cast<std::size_t>(node.parent)) : "";
    std::string key = NodeKey(node, parent);
    std::size_t ordinal = 0;
    while (!used.insert(key).second) {
      key = NodeKey(node, parent + "|duplicate:" + std::to_string(++ordinal));
    }
    keys.push_back(std::move(key));
  }
  return keys;
}

Json ContextToJson(const ContextRecord& context, std::optional<std::uint64_t> generation) {
  Json json = {
      {"hwnd", Decimal(context.hwnd)},
      {"pid", context.pid},
      {"processStart", Decimal(context.processStart)},
      {"executable", context.executable},
      {"dpi", context.dpi},
      {"bounds",
       {{"left", context.bounds[0]}, {"top", context.bounds[1]}, {"right", context.bounds[2]},
        {"bottom", context.bounds[3]}}},
      {"minimized", context.minimized},
  };
  if (context.title) json["title"] = *context.title;
  if (generation) json["generation"] = *generation;
  return json;
}

bool SameInstance(const ContextRecord& left, const ContextRecord& right) {
  return left.hwnd == right.hwnd && left.pid == right.pid && left.processStart == right.processStart &&
         left.executable == right.executable;
}

Json NodeToJson(const NodeRecord& node, const std::string* key, const std::string* parentKey) {
  Json json;
  if (key) {
    json["key"] = *key;
    json["parentKey"] = parentKey ? Json(*parentKey) : Json(nullptr);
  }
  json["runtimeId"] = node.runtimeId;
  const char* type = classify::ControlTypeName(node.controlType);
  json["controlType"] = type ? type : "Custom";
  json["automationId"] = node.automationId;
  json["depth"] = node.depth;
  if (!key) json["parent"] = node.parent;
  json["focused"] = node.focused;
  json["providerOffscreen"] = node.providerOffscreen;
  json["password"] = node.password ? Json(*node.password) : Json(nullptr);
  if (!node.redaction.empty()) json["redaction"] = node.redaction;
  if (!node.documentStatus.empty()) json["documentStatus"] = node.documentStatus;
  if (node.className) json["className"] = *node.className;
  if (node.name) json["name"] = *node.name;
  if (node.text) json["text"] = *node.text;
  if (node.visibleText) json["visibleText"] = *node.visibleText;
  if (node.value) json["value"] = *node.value;
  if (node.bounds) json["bounds"] = {(*node.bounds)[0], (*node.bounds)[1], (*node.bounds)[2], (*node.bounds)[3]};
  if (!node.missing.empty()) json["missing"] = node.missing;
  return json;
}

Json WorkerRequestToJson(const WorkerRequest& request) {
  Json json = {
      {"protocol", kWorkerProtocol},
      {"hwnd", Decimal(request.hwnd)},
      {"pid", request.pid},
      {"processStart", Decimal(request.processStart)},
      {"executable", request.executable},
      {"policyText", request.policyText},
  };
  if (request.testSleepMs) json["testSleepMs"] = request.testSleepMs;
  if (!request.testGate.empty()) json["testGate"] = request.testGate;
  return json;
}

bool WorkerRequestFromJson(const Json& json, bool allowTestFields, WorkerRequest& out) {
  if (allowTestFields) {
    if (!OnlyKeys(json, {"protocol", "hwnd", "pid", "processStart", "executable", "policyText", "testSleepMs",
                         "testGate"})) {
      return false;
    }
  } else if (!OnlyKeys(json, {"protocol", "hwnd", "pid", "processStart", "executable", "policyText"})) {
    return false;
  }
  std::string protocol;
  std::uint64_t pid = 0;
  if (!GetString(json, "protocol", 64, protocol) || protocol != kWorkerProtocol || !GetDecimal(json, "hwnd", out.hwnd) ||
      !GetUnsigned(json, "pid", 0xFFFFFFFFull, pid) || !GetDecimal(json, "processStart", out.processStart) ||
      !GetString(json, "executable", 65536, out.executable) ||
      !GetString(json, "policyText", policy::kMaxPolicyBytes, out.policyText)) {
    return false;
  }
  out.pid = static_cast<std::uint32_t>(pid);
  if (out.hwnd == 0 || out.pid == 0) return false;
  if (json.contains("testSleepMs")) {
    std::uint64_t sleep = 0;
    if (!GetUnsigned(json, "testSleepMs", 60000, sleep)) return false;
    out.testSleepMs = static_cast<std::uint32_t>(sleep);
  }
  if (json.contains("testGate") && !GetString(json, "testGate", 256, out.testGate)) return false;
  return true;
}

Json WorkerResponseToJson(const WorkerResponse& response) {
  Json nodes = Json::array();
  for (const auto& node : response.nodes) nodes.push_back(NodeToJson(node, nullptr, nullptr));
  Json json = {
      {"protocol", kWorkerProtocol},
      {"status", response.status},
      {"reason", response.reason},
      {"context", response.context ? ContextToJson(*response.context, std::nullopt) : Json(nullptr)},
      {"nodes", std::move(nodes)},
      {"truncated", response.truncated},
      {"truncation", response.truncation},
      {"stats",
       {{"visited", response.stats.visited},
        {"emitted", response.stats.emitted},
        {"redacted", response.stats.redacted},
        {"foreignSkipped", response.stats.foreignSkipped},
        {"missingProperties", response.stats.missingProperties}}},
      {"elapsedMs", response.elapsedMs},
  };
  return json;
}

bool WorkerResponseFromJson(const Json& json, const policy::Policy& policy, const policy::AppRule& rule,
                            WorkerResponse& out, std::string& error) {
  error = "worker_invalid_output";
  if (!OnlyKeys(json, {"protocol", "status", "reason", "context", "nodes", "truncated", "truncation", "stats",
                       "elapsedMs"})) {
    return false;
  }
  std::string protocol;
  if (!GetString(json, "protocol", 64, protocol) || protocol != kWorkerProtocol) return false;
  if (!GetString(json, "status", 32, out.status) || !GetString(json, "reason", 64, out.reason)) return false;
  if (out.status == "ok") {
    if (!out.reason.empty()) return false;
  } else if (out.status == "blocked" || out.status == "unavailable") {
    if (!IsKnownReason(out.reason)) return false;
  } else {
    return false;
  }
  const auto context = json.find("context");
  if (context == json.end()) return false;
  if (!context->is_null()) {
    ContextRecord record;
    if (!ContextFromJson(*context, record)) return false;
    out.context = std::move(record);
  } else if (out.status == "ok") {
    return false;
  }
  const auto truncated = json.find("truncated");
  const auto elapsed = json.find("elapsedMs");
  if (truncated == json.end() || !truncated->is_boolean() || elapsed == json.end() || !elapsed->is_number()) return false;
  out.truncated = truncated->get<bool>();
  out.elapsedMs = elapsed->get<double>();
  const auto truncation = json.find("truncation");
  if (truncation == json.end() || !truncation->is_array() || truncation->size() > kTruncations.size()) return false;
  for (const auto& item : *truncation) {
    if (!item.is_string()) return false;
    const auto& code = item.get_ref<const std::string&>();
    if (std::find(kTruncations.begin(), kTruncations.end(), code) == kTruncations.end()) return false;
    out.truncation.push_back(code);
  }
  const auto stats = json.find("stats");
  if (stats == json.end() ||
      !OnlyKeys(*stats, {"visited", "emitted", "redacted", "foreignSkipped", "missingProperties"}) ||
      !GetUnsigned(*stats, "visited", 1000000, out.stats.visited) ||
      !GetUnsigned(*stats, "emitted", 1000000, out.stats.emitted) ||
      !GetUnsigned(*stats, "redacted", 1000000, out.stats.redacted) ||
      !GetUnsigned(*stats, "foreignSkipped", 1000000, out.stats.foreignSkipped) ||
      !GetUnsigned(*stats, "missingProperties", 10000000, out.stats.missingProperties)) {
    return false;
  }
  const auto nodes = json.find("nodes");
  if (nodes == json.end() || !nodes->is_array()) return false;
  if (out.status != "ok" && !nodes->empty()) return false;
  if (nodes->size() > static_cast<std::size_t>(policy.limits.maxNodes)) return false;

  std::size_t totalText = 0;
  std::vector<bool> blocksChildren;
  for (std::size_t i = 0; i < nodes->size(); ++i) {
    NodeRecord node;
    if (!NodeFromJson((*nodes)[i], node)) return false;
    // Tree shape: preorder, root first, parents precede children with depth + 1.
    if (i == 0) {
      if (node.parent != -1 || node.depth != 0) return false;
    } else {
      if (node.parent < 0 || static_cast<std::size_t>(node.parent) >= i) return false;
      if (node.depth != out.nodes[static_cast<std::size_t>(node.parent)].depth + 1) return false;
      if (blocksChildren[static_cast<std::size_t>(node.parent)]) {
        error = "worker_privacy_violation";
        return false;
      }
    }
    if (node.depth > policy.limits.maxDepth) return false;
    const bool hasContent = node.name || node.text || node.visibleText || node.value;
    if (!node.redaction.empty() && hasContent) {
      error = "worker_privacy_violation";
      return false;
    }
    const bool scoped = IsVsCodeEditorBody(node, out.nodes, rule) || IsWordDocument(node, out.nodes, rule) ||
      IsNotepadDocument(node, out.nodes, rule);
    if ((!node.documentStatus.empty() && !scoped) || (scoped && hasContent && node.documentStatus != "available")) {
      error = "worker_privacy_violation";
      return false;
    }
    if (node.documentStatus == "available") {
      auto checked = node;
      FinalizeScopedDocument(checked);
      if (checked.documentStatus != "available") { error = "worker_privacy_violation"; return false; }
    } else if (!node.documentStatus.empty() && (hasContent || node.redaction != "edit_control")) {
      error = "worker_privacy_violation";
      return false;
    }
    const auto permitted = Recheck(node, policy, rule, true, scoped);
    if ((node.name && !permitted.readName) || ((node.text || node.visibleText) && !permitted.readDocumentText) ||
        (node.value && !permitted.readSearchValue)) {
      error = "worker_privacy_violation";
      return false;
    }
    // Evaluated without pattern availability: the most restrictive view that still lets an
    // unreadable authorized Document fall back to its independently checked children.
    blocksChildren.push_back(!Recheck(node, policy, rule, false, scoped).traverseChildren || (scoped && !node.documentStatus.empty()));
    for (const auto* field : {&node.name, &node.text, &node.visibleText, &node.value}) {
      if (!*field) continue;
      const auto units = text::Utf16Length(**field).value_or(SIZE_MAX);
      if (units > static_cast<std::size_t>(policy.limits.maxNodeTextChars)) return false;
      totalText += units;
    }
    if (totalText > static_cast<std::size_t>(policy.limits.maxTextChars)) return false;
    out.nodes.push_back(std::move(node));
  }
  error.clear();
  return true;
}

}  // namespace memmy::protocol
