#include "common/policy.h"

#include "common/classify.h"
#include "common/json.h"
#include "common/text.h"

#include <algorithm>
#include <array>
#include <initializer_list>

namespace memmy::policy {
namespace {

constexpr std::size_t kMaxApplications = 32;
constexpr std::size_t kMaxListEntries = 256;
constexpr std::size_t kMaxSelectors = 32;
constexpr std::size_t kMaxPathChars = 32767;
constexpr std::size_t kMaxIdChars = 256;

class Parser {
 public:
  bool Fail(std::string code, std::string path) {
    if (error_.code.empty()) error_ = {std::move(code), std::move(path)};
    return false;
  }
  const ParseError& Error() const { return error_; }

  bool Keys(const Json& object, const std::string& path, std::initializer_list<std::string_view> allowed) {
    if (!object.is_object()) return Fail("type_invalid", path);
    for (const auto& item : object.items()) {
      if (std::find(allowed.begin(), allowed.end(), item.key()) == allowed.end()) {
        return Fail("unknown_key", path);
      }
    }
    return true;
  }

  bool String(const Json& value, const std::string& path, std::size_t maxChars, std::wstring& out) {
    if (!value.is_string()) return Fail("type_invalid", path);
    auto wide = text::FromUtf8(value.get_ref<const std::string&>());
    if (!wide) return Fail("encoding_invalid", path);
    if (wide->empty() || wide->size() > maxChars) return Fail("range_invalid", path);
    if (wide->find(L'\0') != std::wstring::npos) return Fail("range_invalid", path);
    out = std::move(*wide);
    return true;
  }

  bool Integer(const Json& value, const std::string& path, std::uint64_t min, std::uint64_t max,
               std::uint64_t& out) {
    if (!value.is_number_unsigned()) return Fail("type_invalid", path);
    const auto number = value.get<std::uint64_t>();
    if (number < min || number > max) return Fail("range_invalid", path);
    out = number;
    return true;
  }

  // Pointer-sized and FILETIME identities are decimal strings so JavaScript never rounds them.
  bool DecimalString(const Json& value, const std::string& path, std::uint64_t& out) {
    if (!value.is_string()) return Fail("type_invalid", path);
    auto parsed = text::ParseUnsignedDecimal(std::string_view(value.get_ref<const std::string&>()));
    if (!parsed || *parsed == 0) return Fail("range_invalid", path);
    out = *parsed;
    return true;
  }

  bool AbsolutePath(const Json& value, const std::string& path, std::wstring& out) {
    if (!String(value, path, kMaxPathChars, out)) return false;
    const bool drive = out.size() >= 3 && ((out[0] >= L'A' && out[0] <= L'Z') || (out[0] >= L'a' && out[0] <= L'z')) &&
                       out[1] == L':' && (out[2] == L'\\' || out[2] == L'/');
    const bool unc = out.size() >= 3 && (out[0] == L'\\' || out[0] == L'/') && (out[1] == L'\\' || out[1] == L'/') &&
                     out[2] != L'?' && out[2] != L'.';
    if (!drive && !unc) return Fail("path_not_absolute", path);
    return true;
  }

  bool StringList(const Json& value, const std::string& path, std::size_t maxChars, std::vector<std::wstring>& out) {
    if (!value.is_array()) return Fail("type_invalid", path);
    if (value.size() > kMaxListEntries) return Fail("range_invalid", path);
    for (std::size_t i = 0; i < value.size(); ++i) {
      std::wstring item;
      if (!String(value[i], path + "/" + std::to_string(i), maxChars, item)) return false;
      out.push_back(std::move(item));
    }
    return true;
  }

  bool Selectors(const Json& value, const std::string& path, std::initializer_list<long> allowedTypes,
                 std::vector<ElementSelector>& out, bool allowScopes = false) {
    if (!value.is_array()) return Fail("type_invalid", path);
    if (value.size() > kMaxSelectors) return Fail("range_invalid", path);
    for (std::size_t i = 0; i < value.size(); ++i) {
      const std::string itemPath = path + "/" + std::to_string(i);
      const Json& item = value[i];
      if (!Keys(item, itemPath, {"controlType", "automationId", "scope"})) return false;
      if (!item.contains("controlType") || !item.contains("automationId")) return Fail("missing_key", itemPath);
      const Json& type = item["controlType"];
      if (!type.is_string()) return Fail("type_invalid", itemPath + "/controlType");
      const auto controlType = classify::ControlTypeFromName(type.get_ref<const std::string&>());
      if (!controlType || std::find(allowedTypes.begin(), allowedTypes.end(), *controlType) == allowedTypes.end()) {
        return Fail("selector_type_invalid", itemPath + "/controlType");
      }
      ElementSelector selector;
      selector.controlType = *controlType;
      if (item.contains("scope")) {
        if (!allowScopes || item["automationId"] != "") return Fail("selector_scope_invalid", itemPath);
        if (item["scope"] == "vscode.editor" && *controlType == classify::kEdit) selector.vscodeEditor = true;
        else if (item["scope"] == "word.document" && *controlType == classify::kDocument) selector.wordDocument = true;
        else return Fail("selector_scope_invalid", itemPath);
      } else if (!String(item["automationId"], itemPath + "/automationId", kMaxIdChars, selector.automationId)) return false;
      out.push_back(std::move(selector));
    }
    return true;
  }

  bool Application(const Json& value, const std::string& path, AppRule& rule) {
    if (!Keys(value, path, {"pid", "executable", "processStart", "hwnd", "searchFields", "documentRegions",
                            "sensitiveAutomationIds", "browser", "captureText"})) {
      return false;
    }
    if (!value.contains("pid") || !value.contains("executable")) return Fail("missing_key", path);
    std::uint64_t pid = 0;
    if (!Integer(value["pid"], path + "/pid", 1, 0xFFFFFFFFull, pid)) return false;
    rule.pid = static_cast<std::uint32_t>(pid);
    if (!AbsolutePath(value["executable"], path + "/executable", rule.executable)) return false;
    if (value.contains("captureText")) {
      if (!value["captureText"].is_boolean()) return Fail("capture_text_invalid", path + "/captureText");
      rule.captureText = value["captureText"].get<bool>();
    }
    if (value.contains("browser")) {
      if (!value["browser"].is_string()) return Fail("browser_invalid", path + "/browser");
      rule.browser = browser::FromName(value["browser"].get_ref<const std::string&>());
      if (!browser::MatchesExecutable(rule.browser, rule.executable)) return Fail("browser_invalid", path + "/browser");
    }
    if (value.contains("processStart")) {
      std::uint64_t start = 0;
      if (!DecimalString(value["processStart"], path + "/processStart", start)) return false;
      rule.processStart = start;
    }
    if (value.contains("hwnd")) {
      std::uint64_t hwnd = 0;
      if (!DecimalString(value["hwnd"], path + "/hwnd", hwnd)) return false;
      rule.hwnd = hwnd;
    }
    if (value.contains("searchFields") &&
        !Selectors(value["searchFields"], path + "/searchFields", {classify::kEdit}, rule.searchFields)) {
      return false;
    }
    if (value.contains("documentRegions") &&
        !Selectors(value["documentRegions"], path + "/documentRegions", {classify::kDocument, classify::kEdit},
                   rule.documentRegions, true)) {
      return false;
    }
    for (const auto& selector : rule.documentRegions) {
      if (!rule.captureText && selector.vscodeEditor && !HasVsCodeEditorScope(rule)) return Fail("selector_scope_invalid", path + "/documentRegions");
      if (!rule.captureText && selector.wordDocument && !HasWordDocumentScope(rule)) return Fail("selector_scope_invalid", path + "/documentRegions");
    }
    if (value.contains("sensitiveAutomationIds") &&
        !StringList(value["sensitiveAutomationIds"], path + "/sensitiveAutomationIds", kMaxIdChars,
                    rule.sensitiveAutomationIds)) {
      return false;
    }
    return true;
  }

  bool LimitValue(const Json& limits, const char* key, int min, int max, int& out) {
    if (!limits.contains(key)) return true;
    std::uint64_t value = 0;
    if (!Integer(limits[key], std::string("/limits/") + key, static_cast<std::uint64_t>(min),
                 static_cast<std::uint64_t>(max), value)) {
      return false;
    }
    out = static_cast<int>(value);
    return true;
  }

  bool LimitsObject(const Json& value, Limits& limits) {
    if (!Keys(value, "/limits", {"maxDepth", "maxNodes", "maxVisited", "maxTextChars", "maxNodeTextChars",
                                 "queryBudgetMs", "workerTimeoutMs"})) {
      return false;
    }
    if (!LimitValue(value, "maxDepth", 1, 64, limits.maxDepth) ||
        !LimitValue(value, "maxNodes", 1, 5000, limits.maxNodes) ||
        !LimitValue(value, "maxVisited", 1, 20000, limits.maxVisited) ||
        !LimitValue(value, "maxTextChars", 1, 200000, limits.maxTextChars) ||
        !LimitValue(value, "maxNodeTextChars", 1, 20000, limits.maxNodeTextChars) ||
        !LimitValue(value, "queryBudgetMs", 50, 10000, limits.queryBudgetMs) ||
        !LimitValue(value, "workerTimeoutMs", 200, 30000, limits.workerTimeoutMs)) {
      return false;
    }
    if (limits.maxVisited < limits.maxNodes) return Fail("range_invalid", "/limits/maxVisited");
    if (limits.maxNodeTextChars > limits.maxTextChars) return Fail("range_invalid", "/limits/maxNodeTextChars");
    if (limits.workerTimeoutMs <= limits.queryBudgetMs) return Fail("range_invalid", "/limits/workerTimeoutMs");
    return true;
  }

  bool PolicyObject(const Json& root, Policy& policy) {
    if (!Keys(root, "", {"version", "applications", "defaultApplicationBehavior", "deny", "sensitiveAutomationIds", "limits"})) return false;
    if (!root.contains("version") || !root.contains("applications")) return Fail("missing_key", "");
    if (!root["version"].is_number_unsigned() || root["version"].get<std::uint64_t>() != 1) {
      return Fail("version_unsupported", "/version");
    }
    const Json& applications = root["applications"];
    bool broadScope = false;
    if (root.contains("defaultApplicationBehavior")) {
      const auto& behavior = root["defaultApplicationBehavior"];
      if (!behavior.is_string() || (behavior != "observe" && behavior != "do_not_observe")) {
        return Fail("range_invalid", "/defaultApplicationBehavior");
      }
      broadScope = behavior == "observe";
    }
    if (!applications.is_array()) return Fail("type_invalid", "/applications");
    if (applications.empty() || applications.size() > (broadScope ? 512 : kMaxApplications)) return Fail("range_invalid", "/applications");
    for (std::size_t i = 0; i < applications.size(); ++i) {
      AppRule rule;
      if (!Application(applications[i], "/applications/" + std::to_string(i), rule)) return false;
      policy.applications.push_back(std::move(rule));
    }
    if (root.contains("deny")) {
      const Json& deny = root["deny"];
      if (!Keys(deny, "/deny", {"executables", "pids"})) return false;
      if (deny.contains("executables")) {
        const Json& list = deny["executables"];
        if (!list.is_array()) return Fail("type_invalid", "/deny/executables");
        if (list.size() > kMaxListEntries) return Fail("range_invalid", "/deny/executables");
        for (std::size_t i = 0; i < list.size(); ++i) {
          std::wstring path;
          if (!AbsolutePath(list[i], "/deny/executables/" + std::to_string(i), path)) return false;
          policy.deniedExecutables.push_back(std::move(path));
        }
      }
      if (deny.contains("pids")) {
        const Json& list = deny["pids"];
        if (!list.is_array()) return Fail("type_invalid", "/deny/pids");
        if (list.size() > kMaxListEntries) return Fail("range_invalid", "/deny/pids");
        for (std::size_t i = 0; i < list.size(); ++i) {
          std::uint64_t pid = 0;
          if (!Integer(list[i], "/deny/pids/" + std::to_string(i), 1, 0xFFFFFFFFull, pid)) return false;
          policy.deniedPids.push_back(static_cast<std::uint32_t>(pid));
        }
      }
    }
    if (root.contains("sensitiveAutomationIds") &&
        !StringList(root["sensitiveAutomationIds"], "/sensitiveAutomationIds", kMaxIdChars,
                    policy.sensitiveAutomationIds)) {
      return false;
    }
    if (root.contains("limits") && !LimitsObject(root["limits"], policy.limits)) return false;
    return true;
  }

 private:
  ParseError error_;
};

std::wstring_view Basename(std::wstring_view path) {
  const auto slash = path.find_last_of(L"\\/");
  return slash == std::wstring_view::npos ? path : path.substr(slash + 1);
}

}  // namespace

ParseResult Parse(std::string_view utf8) {
  ParseResult result;
  if (utf8.size() > kMaxPolicyBytes) {
    result.error = {"too_large", ""};
    return result;
  }
  // Optional UTF-8 BOM (written by some Windows editors) is the only tolerated prefix.
  if (utf8.size() >= 3 && utf8.substr(0, 3) == "\xEF\xBB\xBF") utf8.remove_prefix(3);
  const auto json = ParseJsonStrict(utf8, 16);
  if (!json) {
    result.error = {"json_invalid", ""};
    return result;
  }
  Parser parser;
  Policy policy;
  try {
    if (!parser.PolicyObject(*json, policy)) {
      result.error = parser.Error();
      return result;
    }
  } catch (const Json::exception&) {
    result.error = {"type_invalid", ""};
    return result;
  }
  result.policy = std::move(policy);
  return result;
}

bool IsKnownBrowserExecutable(std::wstring_view executablePath) {
  static constexpr std::array<std::wstring_view, 22> kBrowsers = {
      L"msedge.exe",   L"chrome.exe",     L"firefox.exe",      L"brave.exe",       L"opera.exe",
      L"vivaldi.exe",  L"iexplore.exe",   L"chromium.exe",     L"arc.exe",         L"librewolf.exe",
      L"waterfox.exe", L"thorium.exe",    L"floorp.exe",       L"zen.exe",         L"360se.exe",
      L"360chrome.exe", L"qqbrowser.exe", L"sogouexplorer.exe", L"2345explorer.exe", L"liebao.exe",
      L"msedgewebview2.exe", L"tor.exe"};
  const auto name = Basename(executablePath);
  return std::any_of(kBrowsers.begin(), kBrowsers.end(),
                     [&](std::wstring_view browser) { return text::EqualsOrdinalIgnoreCase(name, browser); });
}

Decision Evaluate(const Policy& policy, const Target& target, const Canonicalizer& canonicalize) {
  Decision decision;
  if (target.pid == 0 || target.executable.empty()) return decision;
  const auto name = Basename(target.executable);
  if (text::EqualsOrdinalIgnoreCase(name, L"winlogon.exe") || text::EqualsOrdinalIgnoreCase(name, L"logonui.exe") ||
      text::EqualsOrdinalIgnoreCase(name, L"lockapp.exe") ||
      (name.size() >= 4 && text::EqualsOrdinalIgnoreCase(name.substr(name.size() - 4), L".scr"))) {
    decision.verdict = Verdict::Denied;
    decision.reason = "system_surface";
    return decision;
  }
  if (std::find(policy.deniedPids.begin(), policy.deniedPids.end(), target.pid) != policy.deniedPids.end()) {
    decision.verdict = Verdict::Denied;
    decision.reason = "application_denied";
    return decision;
  }
  for (const auto& denied : policy.deniedExecutables) {
    if (text::EqualsOrdinalIgnoreCase(canonicalize(denied), target.executable)) {
      decision.verdict = Verdict::Denied;
      decision.reason = "application_denied";
      return decision;
    }
  }
  const AppRule* match = nullptr;
  for (const auto& rule : policy.applications) {
    if (rule.pid != target.pid) continue;
    if (rule.processStart && *rule.processStart != target.processStart) continue;
    if (rule.hwnd && *rule.hwnd != target.hwnd) continue;
    if (!text::EqualsOrdinalIgnoreCase(canonicalize(rule.executable), target.executable)) continue;
    match = &rule;
    break;
  }
  if (match == nullptr) return decision;
  decision.verdict = Verdict::Allowed;
  decision.rule = match;
  decision.reason = "";
  return decision;
}

bool IsSensitiveAutomationId(const Policy& policy, const AppRule& rule, std::wstring_view automationId) {
  if (automationId.empty()) return false;
  const auto matches = [&](const std::wstring& id) { return text::EqualsOrdinalIgnoreCase(id, automationId); };
  return std::any_of(policy.sensitiveAutomationIds.begin(), policy.sensitiveAutomationIds.end(), matches) ||
         std::any_of(rule.sensitiveAutomationIds.begin(), rule.sensitiveAutomationIds.end(), matches);
}

bool MatchesSelector(const std::vector<ElementSelector>& selectors, long controlType, std::wstring_view automationId) {
  if (automationId.empty()) return false;
  return std::any_of(selectors.begin(), selectors.end(), [&](const ElementSelector& selector) {
    return !selector.vscodeEditor && !selector.wordDocument && selector.controlType == controlType && selector.automationId == automationId;
  });
}

bool HasVsCodeEditorScope(const AppRule& rule) {
  const auto separator = rule.executable.find_last_of(L"/\\");
  const auto basename = std::wstring_view(rule.executable).substr(separator == std::wstring::npos ? 0 : separator + 1);
  return text::EqualsOrdinalIgnoreCase(basename, L"Code.exe") &&
    std::any_of(rule.documentRegions.begin(), rule.documentRegions.end(), [](const auto& selector) { return selector.vscodeEditor; });
}

bool HasWordDocumentScope(const AppRule& rule) {
  const auto separator = rule.executable.find_last_of(L"/\\");
  const auto basename = std::wstring_view(rule.executable).substr(separator == std::wstring::npos ? 0 : separator + 1);
  return text::EqualsOrdinalIgnoreCase(basename, L"WINWORD.EXE") &&
    std::any_of(rule.documentRegions.begin(), rule.documentRegions.end(), [](const auto& selector) { return selector.wordDocument; });
}

}  // namespace memmy::policy
