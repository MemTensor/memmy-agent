// Unit tests for the pure recorder logic. Each test states a contract the recorder relies on
// (privacy decisions, strict parsing, identity precision, bounded structures), not the
// implementation's internal steps.

#include "common/baseline.h"
#include "common/classify.h"
#include "common/cli.h"
#include "common/json.h"
#include "common/policy.h"
#include "common/protocol.h"
#include "common/text.h"
#include "common/trigger_queue.h"

#include <windows.h>
#include <shellapi.h>

#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#pragma comment(lib, "shell32.lib")

namespace {

using namespace memmy;

struct TestCase {
  const char* name;
  std::function<void()> body;
};
std::vector<TestCase>& Registry() {
  static std::vector<TestCase> tests;
  return tests;
}
struct Register {
  Register(const char* name, std::function<void()> body) { Registry().push_back({name, std::move(body)}); }
};
int g_failures = 0;
const char* g_current = "";

void Check(bool condition, const char* expression, int line) {
  if (!condition) {
    ++g_failures;
    std::fprintf(stderr, "  FAIL [%s] line %d: %s\n", g_current, line, expression);
  }
}

#define TEST(name) \
  static void name(); \
  static Register register_##name(#name, name); \
  static void name()
#define CHECK(expr) Check(static_cast<bool>(expr), #expr, __LINE__)

std::string PolicyJson(const std::string& applicationExtra = "", const std::string& rootExtra = "") {
  return std::string(R"({"version":1,"applications":[{"pid":4242,"executable":"C:\\Apps\\Tool.exe")") +
         applicationExtra + "}]" + rootExtra + "}";
}

policy::Policy MustParse(const std::string& text) {
  auto result = policy::Parse(text);
  CHECK(result.policy.has_value());
  return result.policy.value_or(policy::Policy{});
}

std::string ParseError(const std::string& text) {
  auto result = policy::Parse(text);
  CHECK(!result.policy.has_value());
  return result.error.code;
}

std::wstring Identity(const std::wstring& path) { return path; }

policy::Target ToolTarget() {
  policy::Target target;
  target.pid = 4242;
  target.processStart = 134353330812549066ull;
  target.hwnd = 1704818;
  target.executable = L"c:\\apps\\TOOL.EXE";
  return target;
}

// ---------------------------------------------------------------- text / identity precision

TEST(utf16_to_utf8_replaces_unpaired_surrogates) {
  CHECK(text::ToUtf8(L"a\U0001F600b") == "a\xF0\x9F\x98\x80" "b");
  CHECK(text::ToUtf8(std::wstring(1, static_cast<wchar_t>(0xD83D))) == "\xEF\xBF\xBD");
  CHECK(text::ToUtf8(std::wstring{static_cast<wchar_t>(0xDE00), L'x'}) == "\xEF\xBF\xBDx");
  CHECK(text::ToUtf8(L"中文") == "\xE4\xB8\xAD\xE6\x96\x87");
}

TEST(utf8_decoder_is_strict) {
  CHECK(text::FromUtf8("\xE4\xB8\xAD") == std::wstring(L"中"));
  CHECK(!text::FromUtf8("\xC0\x80"));          // overlong NUL
  CHECK(!text::FromUtf8("\xE0\x80\xAF"));      // overlong '/'
  CHECK(!text::FromUtf8("\xED\xA0\x80"));      // encoded surrogate
  CHECK(!text::FromUtf8("\xF4\x90\x80\x80"));  // above U+10FFFF
  CHECK(!text::FromUtf8("\xE4\xB8"));          // truncated
  CHECK(!text::FromUtf8("\x80"));              // lone continuation
  CHECK(text::Utf16Length("\xF0\x9F\x98\x80") == std::optional<std::size_t>(2));
}

TEST(truncation_never_splits_a_surrogate_pair) {
  const std::wstring value = L"ab\U0001F600cd";  // a b [hi lo] c d
  CHECK(text::TruncateUtf16(value, 3) == L"ab");
  CHECK(text::TruncateUtf16(value, 4) == L"ab\U0001F600");
  CHECK(text::TruncateUtf16(value, 100) == value);
  CHECK(text::TruncateUtf16(value, 0).empty());
}

TEST(identity_decimals_are_exact_and_strict) {
  CHECK(text::ParseUnsignedDecimal(std::string_view("0")) == std::optional<std::uint64_t>(0));
  CHECK(text::ParseUnsignedDecimal(std::string_view("18446744073709551615")) ==
        std::optional<std::uint64_t>(18446744073709551615ull));
  CHECK(!text::ParseUnsignedDecimal(std::string_view("18446744073709551616")));
  CHECK(!text::ParseUnsignedDecimal(std::string_view("007")));
  CHECK(!text::ParseUnsignedDecimal(std::string_view("+7")));
  CHECK(!text::ParseUnsignedDecimal(std::string_view(" 7")));
  CHECK(!text::ParseUnsignedDecimal(std::string_view("7.0")));
  CHECK(!text::ParseUnsignedDecimal(std::string_view("")));
  // Two process start times one tick apart differ as strings; as doubles they would collide.
  const std::uint64_t a = 134353330812549066ull;
  const std::uint64_t b = a + 1;
  CHECK(static_cast<double>(a) == static_cast<double>(b));
  protocol::ContextRecord ca, cb;
  ca.processStart = a;
  cb.processStart = b;
  const std::string ja = DumpJson(protocol::ContextToJson(ca, std::nullopt));
  const std::string jb = DumpJson(protocol::ContextToJson(cb, std::nullopt));
  CHECK(ja.find("\"processStart\":\"134353330812549066\"") != std::string::npos);
  CHECK(jb.find("\"processStart\":\"134353330812549067\"") != std::string::npos);
  CHECK(ja.find("\"hwnd\":\"0\"") != std::string::npos);
}

TEST(path_comparison_is_ordinal_case_insensitive) {
  CHECK(text::EqualsOrdinalIgnoreCase(L"C:\\Program Files\\Ä.exe", L"c:\\PROGRAM FILES\\ä.EXE"));
  CHECK(!text::EqualsOrdinalIgnoreCase(L"C:\\a.exe", L"C:\\a.exe "));
}

// ---------------------------------------------------------------- JSON

TEST(strict_json_rejects_ambiguous_documents) {
  CHECK(ParseJsonStrict(R"({"a":1,"b":{"c":2}})", 8).has_value());
  CHECK(!ParseJsonStrict(R"({"a":1,"a":2})", 8));
  CHECK(!ParseJsonStrict(R"({"a":{"x":1,"x":1}})", 8));
  CHECK(!ParseJsonStrict(R"({"a":1} // c)", 8));
  CHECK(!ParseJsonStrict(R"({"a":1,})", 8));
  CHECK(!ParseJsonStrict("{\"a\":\"\xC0\x80\"}", 8));
  CHECK(!ParseJsonStrict(R"([[[[[[1]]]]]])", 3));
  CHECK(!ParseJsonStrict(R"({"a":1} {"b":2})", 8));
}

TEST(json_output_escapes_controls_and_keeps_utf8) {
  Json value = {{"s", std::string("q\"\\\n\x01 中")}};
  const std::string out = DumpJson(value);
  CHECK(out == "{\"s\":\"q\\\"\\\\\\n\\u0001 \xE4\xB8\xAD\"}");
  CHECK(out.find('\n') == std::string::npos);  // one JSONL line
  Json bad = {{"s", std::string("x\xFFy")}};
  CHECK(DumpJson(bad) == "{\"s\":\"x\xEF\xBF\xBDy\"}");
}

TEST(utc_timestamps_from_filetime) {
  CHECK(protocol::FormatUtcTimestamp(0) == "1601-01-01T00:00:00.000Z");
  CHECK(protocol::FormatUtcTimestamp(116444736000000000ull) == "1970-01-01T00:00:00.000Z");
  CHECK(protocol::FormatUtcTimestamp(125963012967890000ull) == "2000-02-29T12:34:56.789Z");
}

// ---------------------------------------------------------------- policy parsing

TEST(policy_minimal_and_defaults) {
  const auto policy = MustParse(PolicyJson());
  CHECK(policy.applications.size() == 1);
  CHECK(policy.applications[0].pid == 4242);
  CHECK(!policy.applications[0].processStart);
  CHECK(policy.limits.maxNodes == 400);
  CHECK(policy.limits.workerTimeoutMs == 1500);
  CHECK(MustParse("\xEF\xBB\xBF" + PolicyJson()).applications.size() == 1);
}

TEST(policy_rejects_unknown_and_mistyped_fields) {
  CHECK(ParseError(PolicyJson("", R"(,"allowUnknownPrivate":true)")) == "unknown_key");
  CHECK(ParseError(PolicyJson(R"(,"title":"x")")) == "unknown_key");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"maxNodes":10,"extra":1})")) == "unknown_key");
  CHECK(ParseError(PolicyJson("", R"(,"deny":{"hosts":[]})")) == "unknown_key");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":"4242","executable":"C:\\a.exe"}]})") == "type_invalid");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":4242.0,"executable":"C:\\a.exe"}]})") == "type_invalid");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":-1,"executable":"C:\\a.exe"}]})") == "type_invalid");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":0,"executable":"C:\\a.exe"}]})") == "range_invalid");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":4294967296,"executable":"C:\\a.exe"}]})") == "range_invalid");
  CHECK(ParseError(R"({"version":1,"applications":[{"executable":"C:\\a.exe"}]})") == "missing_key");
  CHECK(ParseError(R"({"version":2,"applications":[{"pid":1,"executable":"C:\\a.exe"}]})") == "version_unsupported");
  CHECK(ParseError(R"({"version":1,"applications":[]})") == "range_invalid");
  CHECK(ParseError(R"({"applications":[{"pid":1,"executable":"C:\\a.exe"}]})") == "missing_key");
  CHECK(ParseError(R"([1,2])") == "type_invalid");
  CHECK(ParseError(R"({"version":1,"version":1,"applications":[{"pid":1,"executable":"C:\\a.exe"}]})") == "json_invalid");
}

TEST(policy_identity_fields_require_lossless_strings) {
  CHECK(ParseError(PolicyJson(R"(,"processStart":134353330812549066)")) == "type_invalid");
  CHECK(ParseError(PolicyJson(R"(,"hwnd":1704818)")) == "type_invalid");
  CHECK(ParseError(PolicyJson(R"(,"hwnd":"0")")) == "range_invalid");
  CHECK(ParseError(PolicyJson(R"(,"hwnd":"0x1A")")) == "range_invalid");
  const auto policy = MustParse(PolicyJson(R"(,"processStart":"134353330812549066","hwnd":"1704818")"));
  CHECK(policy.applications[0].processStart == std::optional<std::uint64_t>(134353330812549066ull));
  CHECK(policy.applications[0].hwnd == std::optional<std::uint64_t>(1704818));
}

TEST(broad_scope_is_bounded_and_still_requires_exact_instance_bindings) {
  Json apps = Json::array();
  for (unsigned pid = 1; pid <= 512; ++pid) apps.push_back({{"pid", pid}, {"executable", "C:\\Apps\\Tool.exe"}, {"processStart", "100"}});
  Json root = {{"version", 1u}, {"applications", apps}, {"defaultApplicationBehavior", "observe"}};
  auto parsed = policy::Parse(DumpJson(root));
  CHECK(parsed.policy.has_value());
  if (parsed.policy) {
    policy::Target target{1, 100, 10, L"C:\\Apps\\Tool.exe"};
    CHECK(policy::Evaluate(*parsed.policy, target, Identity).verdict == policy::Verdict::Allowed);
    target.processStart = 101;
    CHECK(policy::Evaluate(*parsed.policy, target, Identity).verdict == policy::Verdict::NotAuthorized);
  }
  root.erase("defaultApplicationBehavior");
  CHECK(ParseError(DumpJson(root)) == "range_invalid");
  root["defaultApplicationBehavior"] = "observe";
  root["applications"].push_back({{"pid", 600u}, {"executable", "C:\\Apps\\Tool.exe"}});
  CHECK(ParseError(DumpJson(root)) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"defaultApplicationBehavior":"invalid")")) == "range_invalid");
}

TEST(system_lock_and_screen_saver_surfaces_remain_excluded) {
  for (const auto* executable : {L"C:\\Windows\\LockApp.exe", L"C:\\Windows\\LogonUI.exe", L"C:\\Windows\\winlogon.exe", L"C:\\Windows\\Test.SCR"}) {
    policy::Policy settings;
    policy::AppRule rule;
    rule.pid = 1;
    rule.executable = executable;
    settings.applications.push_back(rule);
    policy::Target target{1, 100, 10, executable};
    CHECK(policy::Evaluate(settings, target, Identity).verdict == policy::Verdict::Denied);
  }
}

TEST(policy_requires_absolute_executable_paths) {
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":1,"executable":"Tool.exe"}]})") == "path_not_absolute");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":1,"executable":"..\\Tool.exe"}]})") == "path_not_absolute");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":1,"executable":"\\\\?\\C:\\a.exe"}]})") == "path_not_absolute");
  CHECK(ParseError(R"({"version":1,"applications":[{"pid":1,"executable":""}]})") == "range_invalid");
  CHECK(MustParse(R"({"version":1,"applications":[{"pid":1,"executable":"\\\\server\\share\\a.exe"}]})")
            .applications.size() == 1);
  CHECK(MustParse(R"({"version":1,"applications":[{"pid":1,"executable":"D:/x y/中文.exe"}]})").applications.size() == 1);
}

TEST(policy_limits_are_range_checked) {
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"maxNodes":0})")) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"maxNodes":5001})")) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"maxDepth":65})")) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"maxNodes":100,"maxVisited":50})")) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"queryBudgetMs":1500,"workerTimeoutMs":1500})")) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"maxTextChars":100,"maxNodeTextChars":200})")) == "range_invalid");
  CHECK(ParseError(PolicyJson("", R"(,"limits":{"workerTimeoutMs":100})")) == "range_invalid");
  const auto policy = MustParse(PolicyJson("", R"(,"limits":{"maxNodes":10,"maxVisited":10,"workerTimeoutMs":800})"));
  CHECK(policy.limits.maxNodes == 10);
  CHECK(policy.limits.workerTimeoutMs == 800);
}

TEST(policy_selectors_are_typed_and_exact) {
  CHECK(ParseError(PolicyJson(R"(,"searchFields":[{"controlType":"Document","automationId":"q"}])")) ==
        "selector_type_invalid");
  CHECK(ParseError(PolicyJson(R"(,"documentRegions":[{"controlType":"Text","automationId":"d"}])")) ==
        "selector_type_invalid");
  CHECK(ParseError(PolicyJson(R"(,"documentRegions":[{"controlType":"Bogus","automationId":"d"}])")) ==
        "selector_type_invalid");
  CHECK(ParseError(PolicyJson(R"(,"searchFields":[{"controlType":"Edit"}])")) == "missing_key");
  CHECK(ParseError(PolicyJson(R"(,"searchFields":[{"controlType":"Edit","automationId":""}])")) == "range_invalid");
  CHECK(ParseError(PolicyJson(R"(,"searchFields":[{"controlType":"Edit","automationId":"q","name":"Search"}])")) ==
        "unknown_key");
}

TEST(policy_errors_never_echo_values) {
  const std::string secret = "SECRET-VALUE-123";
  auto result = policy::Parse(PolicyJson(R"(,")" + secret + R"(":1)"));
  CHECK(!result.policy);
  CHECK(result.error.code.find(secret) == std::string::npos);
  CHECK(result.error.path.find(secret) == std::string::npos);
  result = policy::Parse(R"({"version":1,"applications":[{"pid":1,"executable":")" + secret + R"("}]})");
  CHECK(result.error.path == "/applications/0/executable");
}

TEST(policy_size_is_bounded) {
  std::string huge = PolicyJson(R"(,"sensitiveAutomationIds":[")" + std::string(policy::kMaxPolicyBytes, 'a') + R"("])");
  CHECK(ParseError(huge) == "too_large");
}

TEST(documented_example_policy_is_valid) {
  std::FILE* file = nullptr;
  CHECK(fopen_s(&file, MEMMY_EXAMPLE_POLICY, "rb") == 0 && file != nullptr);
  if (file == nullptr) return;
  std::string bytes;
  char buffer[4096];
  for (std::size_t read; (read = std::fread(buffer, 1, sizeof(buffer), file)) > 0;) bytes.append(buffer, read);
  std::fclose(file);
  const auto policy = MustParse(bytes);
  CHECK(policy.applications.size() == 1 && policy.applications[0].searchFields.size() == 1 &&
        policy.applications[0].documentRegions.size() == 1 && policy.deniedExecutables.size() == 1);
}

// ---------------------------------------------------------------- authorization

TEST(evaluate_requires_pid_and_canonical_executable) {
  const auto policy = MustParse(PolicyJson());
  auto decision = policy::Evaluate(policy, ToolTarget(), Identity);
  CHECK(decision.verdict == policy::Verdict::Allowed);
  CHECK(decision.rule == &policy.applications[0]);
  auto other = ToolTarget();
  other.pid = 4243;
  CHECK(policy::Evaluate(policy, other, Identity).verdict == policy::Verdict::NotAuthorized);
  other = ToolTarget();
  other.executable = L"C:\\Apps\\Tool2.exe";
  CHECK(policy::Evaluate(policy, other, Identity).verdict == policy::Verdict::NotAuthorized);
  // Same basename in another directory is a different application.
  other.executable = L"C:\\Temp\\Tool.exe";
  CHECK(policy::Evaluate(policy, other, Identity).verdict == policy::Verdict::NotAuthorized);
}

TEST(evaluate_checks_optional_instance_fields) {
  const auto policy = MustParse(PolicyJson(R"(,"processStart":"134353330812549066","hwnd":"1704818")"));
  CHECK(policy::Evaluate(policy, ToolTarget(), Identity).verdict == policy::Verdict::Allowed);
  auto target = ToolTarget();
  target.processStart += 1;  // PID reuse by a later process
  CHECK(policy::Evaluate(policy, target, Identity).verdict == policy::Verdict::NotAuthorized);
  target = ToolTarget();
  target.hwnd = 525924;  // another window of the same process
  CHECK(policy::Evaluate(policy, target, Identity).verdict == policy::Verdict::NotAuthorized);
}

TEST(deny_wins_over_allow) {
  auto policy = MustParse(PolicyJson("", R"(,"deny":{"executables":["C:\\APPS\\tool.exe"]})"));
  auto decision = policy::Evaluate(policy, ToolTarget(), Identity);
  CHECK(decision.verdict == policy::Verdict::Denied);
  CHECK(decision.rule == nullptr);
  CHECK(std::string(decision.reason) == "application_denied");
  policy = MustParse(PolicyJson("", R"(,"deny":{"pids":[4242]})"));
  CHECK(policy::Evaluate(policy, ToolTarget(), Identity).verdict == policy::Verdict::Denied);
}

TEST(browsers_are_refused_even_when_named) {
  const auto policy = MustParse(R"({"version":1,"applications":[{"pid":9,"executable":"C:\\Edge\\msedge.exe"}]})");
  policy::Target target;
  target.pid = 9;
  target.executable = L"C:\\Edge\\MSEDGE.EXE";
  const auto decision = policy::Evaluate(policy, target, Identity);
  CHECK(decision.verdict == policy::Verdict::BrowserUnsupported);
  CHECK(std::string(decision.reason) == "browser_unsupported");
  CHECK(decision.rule != nullptr);
  CHECK(policy::IsKnownBrowserExecutable(L"D:\\x\\chrome.exe"));
  CHECK(policy::IsKnownBrowserExecutable(L"firefox.exe"));
  CHECK(!policy::IsKnownBrowserExecutable(L"C:\\Apps\\chromeless.exe"));
}

// ---------------------------------------------------------------- node classification

struct Fixture {
  policy::Policy policy = MustParse(PolicyJson(
      R"(,"searchFields":[{"controlType":"Edit","automationId":"q"}],)"
      R"("documentRegions":[{"controlType":"Document","automationId":"doc"},{"controlType":"Edit","automationId":"editor"}],)"
      R"("sensitiveAutomationIds":["Secret-Panel"])",
      R"(,"sensitiveAutomationIds":["global-secret"])"));
  const policy::AppRule& rule() const { return policy.applications[0]; }
  classify::NodeDecision Run(long type, classify::PasswordState password, const wchar_t* id, bool focus = false,
                             bool text = true, bool value = true) const {
    classify::NodeFacts facts;
    facts.controlType = type;
    facts.password = password;
    facts.automationId = id;
    facts.hasKeyboardFocus = focus;
    facts.textPatternAvailable = text;
    facts.valuePatternAvailable = value;
    return classify::Classify(facts, policy, rule());
  }
};

constexpr auto kNo = classify::PasswordState::False;
constexpr auto kYes = classify::PasswordState::True;
constexpr auto kUnknown = classify::PasswordState::Unknown;

bool Blocks(const classify::NodeDecision& d) {
  return !d.readName && !d.readDocumentText && !d.readSearchValue && !d.traverseChildren;
}

TEST(passwords_and_sensitive_ids_block_whole_subtree) {
  Fixture f;
  auto d = f.Run(classify::kEdit, kYes, L"pw");
  CHECK(Blocks(d) && d.redaction == classify::Redaction::Password);
  d = f.Run(classify::kPane, kNo, L"secret-panel");  // case-insensitive deny-direction match
  CHECK(Blocks(d) && d.redaction == classify::Redaction::SensitiveId);
  d = f.Run(classify::kText, kNo, L"global-secret");
  CHECK(Blocks(d));
  // Sensitive wins over an exact document authorization.
  Fixture g;
  g.policy.sensitiveAutomationIds.push_back(L"doc");
  CHECK(Blocks(g.Run(classify::kDocument, kNo, L"doc")));
  // A password-flagged node is blocked even if it is not an Edit.
  CHECK(Blocks(f.Run(classify::kText, kYes, L"")));
}

TEST(ordinary_edits_and_descendants_are_excluded) {
  Fixture f;
  auto d = f.Run(classify::kEdit, kNo, L"notes", true);
  CHECK(Blocks(d) && d.redaction == classify::Redaction::EditControl);
  // An authorized search selector still needs live focus and a ValuePattern.
  CHECK(Blocks(f.Run(classify::kEdit, kNo, L"q", false)));
  CHECK(Blocks(f.Run(classify::kEdit, kNo, L"q", true, true, false)));
  CHECK(Blocks(f.Run(classify::kEdit, kNo, L"Q", true)));  // selectors are exact
  d = f.Run(classify::kEdit, kNo, L"q", true);
  CHECK(d.readSearchValue && d.readName && !d.readDocumentText && !d.traverseChildren);
  // Unknown password state on an Edit is never readable, even when a selector matches.
  CHECK(Blocks(f.Run(classify::kEdit, kUnknown, L"q", true)));
  CHECK(Blocks(f.Run(classify::kEdit, kUnknown, L"editor")));
}

TEST(document_text_requires_exact_selector) {
  Fixture f;
  auto d = f.Run(classify::kDocument, kNo, L"doc");
  CHECK(d.readDocumentText && d.readName && !d.traverseChildren);
  d = f.Run(classify::kDocument, kNo, L"other");
  CHECK(!d.readDocumentText && d.readName && d.traverseChildren);
  d = f.Run(classify::kDocument, kNo, L"doc", false, false);  // no TextPattern: children checked instead
  CHECK(!d.readDocumentText && d.traverseChildren);
  d = f.Run(classify::kEdit, kNo, L"editor");
  CHECK(d.readDocumentText && !d.readSearchValue && !d.traverseChildren);
  // Empty AutomationIds never match.
  Fixture g;
  g.policy.applications[0].documentRegions.push_back({classify::kDocument, L""});
  CHECK(!g.Run(classify::kDocument, kNo, L"").readDocumentText);
}

TEST(unknown_password_masks_containers_but_blocks_content) {
  Fixture f;
  auto d = f.Run(classify::kWindow, kUnknown, L"");
  CHECK(!d.readName && d.traverseChildren && d.redaction == classify::Redaction::UnknownStructural);
  d = f.Run(classify::kPane, kUnknown, L"");
  CHECK(!d.readName && d.traverseChildren);
  d = f.Run(classify::kText, kUnknown, L"");
  CHECK(Blocks(d) && d.redaction == classify::Redaction::UnknownPassword);
  d = f.Run(classify::kDocument, kUnknown, L"doc");
  CHECK(Blocks(d));
  // Static text with a known non-password state is readable.
  d = f.Run(classify::kText, kNo, L"");
  CHECK(d.readName && d.traverseChildren && d.redaction == classify::Redaction::None);
}

// ---------------------------------------------------------------- worker response validation

struct ResponseFixture : Fixture {
  Json Node(const char* type, int depth, int parent, Json extra = Json::object()) {
    Json node = {{"runtimeId", "42." + std::to_string(next++)}, {"controlType", type}, {"automationId", ""},
                 {"depth", depth}, {"parent", parent}, {"focused", false}, {"providerOffscreen", false},
                 {"password", false}};
    for (auto& [key, value] : extra.items()) node[key] = value;
    return node;
  }
  Json Response(Json nodes) {
    protocol::ContextRecord context;
    context.hwnd = 1;
    context.pid = 4242;
    context.processStart = 7;
    context.executable = "C:\\Apps\\Tool.exe";
    return {{"protocol", protocol::kWorkerProtocol}, {"status", "ok"}, {"reason", ""},
            {"context", protocol::ContextToJson(context, std::nullopt)}, {"nodes", std::move(nodes)},
            {"truncated", false}, {"truncation", Json::array()},
            {"stats", {{"visited", 1}, {"emitted", 1}, {"redacted", 0}, {"foreignSkipped", 0}, {"missingProperties", 0}}},
            {"elapsedMs", 1.5}};
  }
  std::string Validate(const Json& response) {
    protocol::WorkerResponse out;
    std::string error;
    return protocol::WorkerResponseFromJson(response, policy, rule(), out, error) ? "ok" : error;
  }
  int next = 1;
};

TEST(worker_response_accepts_permitted_content) {
  ResponseFixture f;
  Json nodes = Json::array({f.Node("Window", 0, -1, {{"name", "Title"}}),
                            f.Node("Text", 1, 0, {{"name", "hello"}}),
                            f.Node("Edit", 1, 0, {{"redaction", "edit_control"}}),
                            f.Node("Edit", 1, 0, {{"automationId", "q"}, {"focused", true}, {"name", "Search"}, {"value", "term"}}),
                            f.Node("Document", 1, 0, {{"automationId", "doc"}, {"text", "body"}, {"visibleText", "body"}})});
  CHECK(f.Validate(f.Response(nodes)) == "ok");
}

TEST(scoped_editor_policy_is_not_an_empty_id_wildcard) {
  const auto good = R"({"version":1,"applications":[{"pid":4242,"executable":"C:\\Apps\\Code.exe","documentRegions":[{"controlType":"Edit","automationId":"","scope":"vscode.editor"}]}]})";
  auto parsed = policy::Parse(good);
  CHECK(parsed.policy && policy::HasVsCodeEditorScope(parsed.policy->applications[0]));
  CHECK(!policy::MatchesSelector(parsed.policy->applications[0].documentRegions, classify::kEdit, L""));
  Json input = *ParseJsonStrict(good, 32);
  input["applications"][0]["executable"] = "C:\\Apps\\Other.exe";
  CHECK(!policy::Parse(DumpJson(input)).policy);
  input = *ParseJsonStrict(good, 32);
  input["applications"][0]["searchFields"] = input["applications"][0]["documentRegions"];
  CHECK(!policy::Parse(DumpJson(input)).policy);
  input = *ParseJsonStrict(good, 32);
  input["applications"][0]["documentRegions"][0].erase("scope");
  CHECK(!policy::Parse(DumpJson(input)).policy);
}

TEST(worker_recomputes_scoped_editor_ancestry_and_availability) {
  ResponseFixture f;
  f.policy.applications[0].executable = L"C:\\Apps\\Code.exe";
  f.policy.applications[0].documentRegions = {{classify::kEdit, L"", true}};
  const Json nodes = Json::array({f.Node("Window", 0, -1),
    f.Node("Group", 1, 0, {{"automationId", "workbench.parts.editor"}}), f.Node("Group", 2, 1), f.Node("Text", 3, 2),
    f.Node("Edit", 4, 3, {{"name", "synthetic.txt"}, {"text", "SYNTHETIC-BODY"}, {"documentStatus", "available"}})});
  CHECK(f.Validate(f.Response(nodes)) == "ok");
  for (const auto& mutate : std::vector<std::function<void(Json&)>>{
      [](Json& n) { n[1]["automationId"] = "workbench.parts.auxiliarybar"; },
      [](Json& n) { n[3]["controlType"] = "Group"; },
      [](Json& n) { n[2]["password"] = true; },
      [](Json& n) { n[3]["password"] = nullptr; },
      [](Json& n) { n[1]["missing"] = Json::array({"automationId"}); },
      [](Json& n) { n[4]["missing"] = Json::array({"automationId"}); },
      [](Json& n) { n[4]["password"] = true; },
      [](Json& n) { n[4].erase("documentStatus"); },
      [](Json& n) { n[4]["documentStatus"] = "label_only"; },
      [](Json& n) { n[4]["text"] = " synthetic.txt\n"; },
      [](Json& n) { n[4]["value"] = "private input"; }}) {
    Json changed = nodes; mutate(changed);
    CHECK(f.Validate(f.Response(changed)) == "worker_privacy_violation");
  }
  f.policy.sensitiveAutomationIds = {L"workbench.parts.editor"};
  CHECK(f.Validate(f.Response(nodes)) == "worker_privacy_violation");
}

TEST(scoped_editor_discards_label_only_and_failed_reads) {
  protocol::NodeRecord node;
  node.name = "Localized unavailable label"; node.text = "Localized unavailable label\r\n";
  node.visibleText = "Localized unavailable label";
  protocol::FinalizeScopedDocument(node);
  CHECK(node.documentStatus == "label_only" && !node.name && !node.text && !node.visibleText && node.redaction == "edit_control");
  node = {}; node.name = "synthetic.txt";
  protocol::FinalizeScopedDocument(node);
  CHECK(node.documentStatus == "read_failed" && !node.name);
  node = {}; node.name = "empty.txt"; node.text = "";
  protocol::FinalizeScopedDocument(node);
  CHECK(node.documentStatus == "available" && node.text.has_value());
}

TEST(word_scope_requires_class_ancestry_and_correct_application) {
  const auto good = R"({"version":1,"applications":[{"pid":4242,"executable":"C:\\Office\\WINWORD.EXE","documentRegions":[{"controlType":"Document","automationId":"","scope":"word.document"}]}]})";
  auto parsed = policy::Parse(good);
  CHECK(parsed.policy && policy::HasWordDocumentScope(parsed.policy->applications[0]));
  CHECK(!policy::MatchesSelector(parsed.policy->applications[0].documentRegions, classify::kDocument, L""));
  Json input = *ParseJsonStrict(good, 32);
  input["applications"][0]["executable"] = "C:\\Apps\\Other.exe";
  CHECK(!policy::Parse(DumpJson(input)).policy);
  input = *ParseJsonStrict(good, 32);
  input["applications"][0]["documentRegions"][0]["controlType"] = "Edit";
  CHECK(!policy::Parse(DumpJson(input)).policy);

  ResponseFixture f;
  f.policy.applications[0].executable = L"C:\\Office\\WINWORD.EXE";
  f.policy.applications[0].documentRegions = {{classify::kDocument, L"", false, true}};
  const Json nodes = Json::array({f.Node("Window", 0, -1, {{"className", "OpusApp"}}),
    f.Node("Pane", 1, 0, {{"className", "_WwF"}}), f.Node("Pane", 2, 1, {{"className", "_WwB"}}),
    f.Node("Document", 3, 2, {{"className", "_WwG"}, {"name", "synthetic.rtf"}, {"text", "WORD-BODY"}, {"documentStatus", "available"}})});
  CHECK(f.Validate(f.Response(nodes)) == "ok");
  for (const auto& mutate : std::vector<std::function<void(Json&)>>{
      [](Json& n) { n[0]["className"] = "#32770"; },
      [](Json& n) { n[1]["className"] = "Search"; },
      [](Json& n) { n[2].erase("className"); },
      [](Json& n) { n[3]["className"] = "RichEdit"; },
      [](Json& n) { n[2]["controlType"] = "Group"; },
      [](Json& n) { n[1]["password"] = nullptr; },
      [](Json& n) { n[3]["password"] = true; },
      [](Json& n) { n[2]["missing"] = Json::array({"automationId"}); },
      [](Json& n) { n[3]["automationId"] = "search"; },
      [](Json& n) { n[3].erase("documentStatus"); },
      [](Json& n) { n[3]["value"] = "private input"; }}) {
    Json changed = nodes; mutate(changed);
    CHECK(f.Validate(f.Response(changed)) == "worker_privacy_violation");
  }
  Json descendants = nodes;
  descendants.push_back(f.Node("Text", 4, 3, {{"name", "private input"}}));
  CHECK(f.Validate(f.Response(descendants)) == "worker_privacy_violation");
}

TEST(notepad_scope_binds_application_and_exact_native_class_chain) {
  const auto good = R"({"version":1,"applications":[{"pid":4242,"executable":"C:\\WindowsApps\\Notepad.exe","documentRegions":[{"controlType":"Document","automationId":"","scope":"notepad.document"}]}]})";
  auto parsed = policy::Parse(good);
  CHECK(parsed.policy && policy::HasNotepadDocumentScope(parsed.policy->applications[0]));
  CHECK(!policy::MatchesSelector(parsed.policy->applications[0].documentRegions, classify::kDocument, L""));
  Json input = *ParseJsonStrict(good, 32);
  input["applications"][0]["executable"] = "C:\\Other.exe";
  CHECK(!policy::Parse(DumpJson(input)).policy);
  input = *ParseJsonStrict(good, 32);
  input["applications"][0]["documentRegions"][0]["controlType"] = "Edit";
  CHECK(!policy::Parse(DumpJson(input)).policy);

  ResponseFixture f;
  f.policy.applications[0].executable = L"C:\\WindowsApps\\Notepad.exe";
  f.policy.applications[0].documentRegions = {{classify::kDocument, L"", false, false, true}};
  const Json nodes = Json::array({f.Node("Window", 0, -1, {{"className", "Notepad"}}),
    f.Node("Pane", 1, 0, {{"className", "NotepadTextBox"}}),
    f.Node("Document", 2, 1, {{"className", "RichEditD2DPT"}, {"name", "Text editor"},
      {"text", "NOTEPAD-BODY"}, {"documentStatus", "available"}})});
  CHECK(f.Validate(f.Response(nodes)) == "ok");
  for (const auto& mutate : std::vector<std::function<void(Json&)>>{
      [](Json& n) { n[0]["className"] = "#32770"; },
      [](Json& n) { n[1]["className"] = "SearchPane"; },
      [](Json& n) { n[1]["password"] = nullptr; },
      [](Json& n) { n[1]["missing"] = Json::array({"automationId"}); },
      [](Json& n) { n[2]["className"] = "RichEdit50W"; },
      [](Json& n) { n[2]["automationId"] = "search"; },
      [](Json& n) { n[2]["password"] = true; },
      [](Json& n) { n[2]["missing"] = Json::array({"automationId"}); },
      [](Json& n) { n[2]["text"] = "Text editor\r\n"; },
      [](Json& n) { n[2].erase("documentStatus"); },
      [](Json& n) { n[2]["value"] = "private input"; }}) {
    Json changed = nodes; mutate(changed);
    CHECK(f.Validate(f.Response(changed)) == "worker_privacy_violation");
  }
  Json descendants = nodes;
  descendants.push_back(f.Node("Text", 3, 2, {{"name", "private input"}}));
  CHECK(f.Validate(f.Response(descendants)) == "worker_privacy_violation");
}

TEST(scoped_editor_rejects_sibling_input_echoes) {
  ResponseFixture f;
  auto& rule = f.policy.applications[0];
  rule.executable = L"C:\\Apps\\Code.exe";
  rule.documentRegions = {{classify::kEdit, L"", true}};
  classify::NodeFacts facts;
  facts.controlType = classify::kText;
  facts.password = classify::PasswordState::False;
  const auto decision = classify::Classify(facts, f.policy, rule);
  CHECK(!decision.readName && !decision.readDocumentText && decision.traverseChildren);
  const auto nodes = Json::array({f.Node("Window", 0, -1),
    f.Node("Text", 1, 0, {{"name", "No results for SYNTHETIC-PRIVATE-QUERY"}})});
  CHECK(f.Validate(f.Response(nodes)) == "worker_privacy_violation");
}

TEST(worker_response_rejects_privacy_violations) {
  ResponseFixture f;
  // Content on an ordinary Edit.
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Edit", 1, 0, {{"name", "typed"}})}))) ==
        "worker_privacy_violation");
  // Child of an Edit (child Text mirroring input).
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Edit", 1, 0, {{"redaction", "edit_control"}}),
                                           f.Node("Text", 2, 1, {{"name", "typed"}})}))) == "worker_privacy_violation");
  // Child of a password node, even without content.
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1),
                                           f.Node("Pane", 1, 0, {{"password", true}, {"redaction", "password"}}),
                                           f.Node("Text", 2, 1)}))) == "worker_privacy_violation");
  // Redacted node carrying content.
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1),
                                           f.Node("Text", 1, 0, {{"redaction", "sensitive_id"}, {"name", "x"}})}))) ==
        "worker_privacy_violation");
  // Search value without focus.
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1),
                                           f.Node("Edit", 1, 0, {{"automationId", "q"}, {"value", "term"}})}))) ==
        "worker_privacy_violation");
  // Document text without a matching selector.
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1),
                                           f.Node("Document", 1, 0, {{"automationId", "x"}, {"text", "body"}})}))) ==
        "worker_privacy_violation");
  // Unknown password state on content.
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1),
                                           f.Node("Text", 1, 0, {{"password", nullptr}, {"name", "x"}})}))) ==
        "worker_privacy_violation");
}

TEST(worker_response_enforces_shape_and_budgets) {
  ResponseFixture f;
  CHECK(f.Validate(f.Response(Json::array({f.Node("Text", 1, -1)}))) == "worker_invalid_output");  // root depth
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Text", 1, 2)}))) == "worker_invalid_output");
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Text", 1, 0, {{"extra", 1}})}))) ==
        "worker_invalid_output");
  Json bad = f.Response(Json::array());
  bad["reason"] = "something_new";
  bad["status"] = "blocked";
  CHECK(f.Validate(bad) == "worker_invalid_output");
  bad["reason"] = "";
  bad["status"] = "ok";
  bad["extra"] = true;
  CHECK(f.Validate(bad) == "worker_invalid_output");
  // Text budget enforced by the collector, independent of the worker.
  f.policy.limits.maxNodeTextChars = 4;
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Text", 1, 0, {{"name", "hello"}})}))) ==
        "worker_invalid_output");
  f.policy.limits.maxNodeTextChars = 100;
  f.policy.limits.maxTextChars = 6;
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Text", 1, 0, {{"name", "abcd"}}),
                                           f.Node("Text", 1, 0, {{"name", "efg"}})}))) == "worker_invalid_output");
  f.policy.limits.maxTextChars = 1000;
  f.policy.limits.maxNodes = 1;
  CHECK(f.Validate(f.Response(Json::array({f.Node("Window", 0, -1), f.Node("Text", 1, 0)}))) == "worker_invalid_output");
}

TEST(node_keys_track_content_focus_and_visibility) {
  protocol::NodeRecord node;
  node.runtimeId = "42.1";
  node.controlType = classify::kText;
  node.name = "hello";
  const std::string key = protocol::NodeKey(node);
  CHECK(key.size() == 16);
  node.bounds = std::array<double, 4>{1, 2, 3, 4};
  CHECK(protocol::NodeKey(node) == key);
  node.focused = true;
  CHECK(protocol::NodeKey(node) != key);
  node.focused = false;
  node.providerOffscreen = true;
  CHECK(protocol::NodeKey(node) != key);
  node.providerOffscreen = false;
  node.name = "hello!";
  CHECK(protocol::NodeKey(node) != key);
  node.name.reset();
  node.text = "hello!";
  CHECK(protocol::NodeKey(node) != key);
}

// ---------------------------------------------------------------- baseline / delta

TEST(baseline_full_then_delta_and_reset) {
  Baseline baseline;
  auto diff = baseline.Apply("ctx1", {"a", "b", "c"});
  CHECK(diff.full && diff.added.size() == 3);
  diff = baseline.Apply("ctx1", {"a", "b", "c"});
  CHECK(!diff.full && diff.added.empty() && diff.removed.empty() && diff.unchanged == 3);
  diff = baseline.Apply("ctx1", {"a", "c", "d"});
  CHECK(!diff.full && diff.added == std::vector<std::size_t>{2} && diff.removed == std::vector<std::string>{"b"});
  // A new context (window, generation, policy revision or pause epoch) is always a full baseline.
  diff = baseline.Apply("ctx2", {"a", "c", "d"});
  CHECK(diff.full && diff.removed.empty());
  baseline.Reset();
  diff = baseline.Apply("ctx2", {"a"});
  CHECK(diff.full && diff.removed.empty());
}

TEST(baseline_counts_duplicates) {
  Baseline baseline;
  baseline.Apply("c", {"x", "x", "y"});
  auto diff = baseline.Apply("c", {"x", "y"});
  CHECK(diff.added.empty() && diff.removed == std::vector<std::string>{"x"});
  diff = baseline.Apply("c", {"x", "x", "y"});
  CHECK(diff.added == std::vector<std::size_t>{1} && diff.removed.empty());
}

TEST(partial_snapshots_do_not_prove_removal_or_establish_baseline) {
  Baseline baseline;
  baseline.Apply("context", {"root", "a", "b", "c"});
  for (const auto& partial : {std::vector<std::string>{"root", "a"}, std::vector<std::string>{"root", "b"}}) {
    const auto diff = baseline.Apply("context", partial, false);
    CHECK(diff.full && diff.removed.empty() && !baseline.HasIdentity());
  }
  auto recovered = baseline.Apply("context", {"root", "a", "b", "c"});
  CHECK(recovered.full && recovered.added.size() == 4 && recovered.removed.empty());
  recovered = baseline.Apply("context", {"root", "a", "c"});
  CHECK(!recovered.full && recovered.removed == std::vector<std::string>{"b"});
}

TEST(parent_content_update_preserves_delta_hierarchy) {
  std::vector<protocol::NodeRecord> nodes(3);
  nodes[0].runtimeId = "root";
  nodes[0].name = "before";
  nodes[1].runtimeId = "child";
  nodes[1].parent = 0;
  nodes[2].runtimeId = "grandchild";
  nodes[2].parent = 1;
  const auto before = protocol::NodeKeys(nodes);
  Baseline baseline;
  baseline.Apply("context", before);
  std::map<std::string, std::string> consumer = {{before[0], ""}, {before[1], before[0]}, {before[2], before[1]}};
  nodes[0].name = "after";
  const auto after = protocol::NodeKeys(nodes);
  const auto diff = baseline.Apply("context", after);
  CHECK(!diff.full && diff.added.size() == 3 && diff.removed.size() == 3);
  for (const auto& key : diff.removed) consumer.erase(key);
  for (const auto index : diff.added) {
    consumer[after[index]] = nodes[index].parent < 0 ? "" : after[static_cast<std::size_t>(nodes[index].parent)];
  }
  CHECK(consumer.size() == 3);
  for (const auto& [key, parent] : consumer) {
    CHECK(key.size() == 16);
    CHECK(parent.empty() || consumer.contains(parent));
  }
}

// ---------------------------------------------------------------- bounded queue

TEST(trigger_queue_is_bounded_and_coalesces) {
  TriggerQueue queue(3);
  CHECK(queue.Push({TriggerKind::NameChange, 1, 1, 10}));
  CHECK(queue.Push({TriggerKind::NameChange, 1, 1, 11}));  // merged
  CHECK(queue.Size() == 1);
  CHECK(queue.Push({TriggerKind::Focus, 1, 1, 12}));
  CHECK(queue.Push({TriggerKind::NameChange, 2, 1, 13}));
  CHECK(!queue.Push({TriggerKind::Show, 1, 1, 14}));  // full: dropped, never blocks
  CHECK(queue.Push({TriggerKind::NameChange, 2, 1, 15}));  // still coalesces into the tail
  auto counters = queue.Counters();
  CHECK(counters.accepted == 3 && counters.coalesced == 2 && counters.dropped == 1);
  bool overflowed = false;
  auto items = queue.Drain(overflowed);
  CHECK(items.size() == 4 && overflowed);
  CHECK(items[2].tickMs == 15);
  CHECK(items[0].firstTickMs == 10 && items[2].firstTickMs == 13);
  CHECK(items[3].kind == TriggerKind::Gap && items[3].lostFromTickMs == 14 && items[3].lostThroughTickMs == 14);
  items = queue.Drain(overflowed);
  CHECK(items.empty() && !overflowed);
  queue.Push({TriggerKind::Input, 1, 1, 1});
  queue.Clear();
  CHECK(queue.Size() == 0 && queue.Counters().discarded == 1);
}

// ---------------------------------------------------------------- command line / control

TEST(keyboard_metadata_never_retains_printable_input) {
  for (const auto key : {'Q', '1', 'A'}) {
    const auto plain = ClassifyKeyboard(key, 0, false);
    CHECK(plain.kind == ActionKind::TextKey && plain.key == 0 && plain.modifiers == 0);
    CHECK(SemanticKey(plain).empty());
    const auto altgr = ClassifyKeyboard(key, 3, true);
    CHECK(altgr.kind == ActionKind::TextKey && altgr.key == 0 && altgr.modifiers == 0 && altgr.injected);
  }
  CHECK(SemanticKey(ClassifyKeyboard('C', 1, false)) == "Control+C");
  CHECK(SemanticKey(ClassifyKeyboard(0x0D, 4, false)) == "Shift+Enter");
  CHECK(SemanticKey(ClassifyKeyboard('E', 8, false)) == "Meta+E");
  CHECK(ClassifyKeyboard(0x10, 4, false).kind == ActionKind::None);
}

TEST(action_queue_preserves_counts_and_context_boundaries) {
  TriggerQueue queue(3);
  Trigger action{TriggerKind::Input, 1, 1, 10};
  action.action = ClassifyKeyboard('Q', 0, false);
  CHECK(queue.Push(action));
  CHECK(queue.Push(action));
  CHECK(queue.Size() == 2);
  CHECK(queue.Push({TriggerKind::Focus, 1, 2, 11}));
  CHECK(!queue.Push({TriggerKind::Focus, 1, 3, 12}));
  bool overflowed = false;
  CHECK(queue.Drain(overflowed).size() == 4 && overflowed);
}

TEST(checkpoint_preserves_fifo_and_distinguishes_losses_on_each_side) {
  TriggerQueue queue(1);
  CHECK(queue.Push({TriggerKind::Input, 1, 1, 10}));
  CHECK(!queue.Push({TriggerKind::Focus, 1, 1, 11}));
  CHECK(queue.PushCheckpoint("first", 12));
  CHECK(!queue.Push({TriggerKind::Focus, 1, 1, 13}));
  CHECK(queue.PushCheckpoint("second", 14));
  bool overflowed = false;
  const auto items = queue.Drain(overflowed);
  CHECK(items.size() == 3 && overflowed);
  CHECK(items[1].checkpointId == "first" && items[1].captureSequence == 3 && items[1].lostFromTickMs == 11);
  CHECK(items[2].checkpointId == "second" && items[2].captureSequence == 5 && items[2].lostFromTickMs == 13);
  CHECK(queue.Push({TriggerKind::Focus, 1, 1, 15}));
  CHECK(queue.PushCheckpoint("third", 16));
  CHECK(!queue.Push({TriggerKind::Focus, 1, 1, 17}));  // Cannot coalesce across a marker.
  const auto next = queue.Drain(overflowed);
  CHECK(next.size() == 3 && next[1].lostFromTickMs == 0 && next[2].kind == TriggerKind::Gap);
  for (int i = 0; i < 16; ++i) CHECK(queue.PushCheckpoint("bounded", 18));
  CHECK(!queue.PushCheckpoint("overflow", 19));
}

TEST(checkpoint_control_accepts_only_a_bounded_identity) {
  CHECK(cli::ParseCheckpointId("checkpoint 12345678-1234-1234-1234-123456789abc").has_value());
  for (const auto* line : {"checkpoint abc", "checkpoint 12345678_1234-1234-1234-123456789abc",
       "checkpoint 12345678-1234-1234-1234-123456789ABC", "checkpoint 12345678-1234-1234-1234-123456789abc extra"})
    CHECK(!cli::ParseCheckpointId(line));
}

cli::ParseResult ParseArgs(std::initializer_list<const wchar_t*> args, bool test = false) {
  std::vector<std::wstring> list;
  for (const auto* arg : args) list.emplace_back(arg);
  return cli::Parse(list, test);
}

TEST(duplicate_node_keys_are_disambiguated_and_children_keep_their_parent) {
  protocol::NodeRecord root;
  root.controlType = classify::kWindow;
  root.parent = -1;
  protocol::NodeRecord sibling;
  sibling.controlType = classify::kPane;
  sibling.parent = 0;
  protocol::NodeRecord child;
  child.controlType = classify::kText;
  child.parent = 2;
  const std::vector<protocol::NodeRecord> nodes = {root, sibling, sibling, child};
  const auto keys = protocol::NodeKeys(nodes);
  CHECK(keys[1] != keys[2]);
  CHECK(keys[3] == protocol::NodeKey(child, keys[2]));
  CHECK(keys == protocol::NodeKeys(nodes));
}

TEST(cli_observe_defaults_and_ranges) {
  auto r = ParseArgs({L"observe", L"--policy", L"p.json"});
  CHECK(r.command && r.command->seconds == 30 && r.command->rotateSeconds == 600 && !r.command->inputHooks);
  CHECK(ParseArgs({L"observe"}).error == "missing_policy");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--seconds", L"0"}).error == "invalid_seconds");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--seconds", L"86401"}).error == "invalid_seconds");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--seconds", L"-5"}).error == "invalid_seconds");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--policy", L"q"}).error == "duplicate_option");
  CHECK(ParseArgs({L"observe", L"--policy"}).error == "missing_option_value");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--hwnd", L"5"}).error == "unknown_option");
  CHECK(ParseArgs({L"snapshot", L"--hwnd", L"5", L"--policy", L"p", L"--input-hooks"}).error == "unknown_option");
  r = ParseArgs({L"observe", L"--policy", L"C:\\a b\\p.json", L"--output", L"D:\\空 格\\o.jsonl", L"--seconds", L"5",
                 L"--rotate-seconds", L"1", L"--parent-pid", L"77", L"--input-hooks", L"--sample-ms", L"250"});
  CHECK(r.command && r.command->outputPath == L"D:\\空 格\\o.jsonl" && r.command->parentPid == std::optional<std::uint32_t>(77) &&
        r.command->inputHooks && r.command->rotateSeconds == 1 && r.command->sampleMs == 250);
}

TEST(cli_other_commands) {
  CHECK(ParseArgs({}).command->kind == cli::CommandKind::Help);
  CHECK(ParseArgs({L"--version"}).command->kind == cli::CommandKind::Version);
  CHECK(ParseArgs({L"help", L"extra"}).error == "unknown_option");
  CHECK(ParseArgs({L"windows"}).error == "missing_pid");
  CHECK(ParseArgs({L"windows", L"--pid", L"0"}).error == "invalid_pid");
  CHECK(ParseArgs({L"snapshot", L"--policy", L"p"}).error == "missing_hwnd");
  CHECK(ParseArgs({L"snapshot", L"--hwnd", L"18446744073709551615", L"--policy", L"p"}).command->hwnd ==
        18446744073709551615ull);
  CHECK(ParseArgs({L"record"}).error == "unknown_command");
  CHECK(ParseArgs({L"__worker", L"--policy", L"p"}).error == "unknown_option");
}

TEST(task_video_cli_is_separate_and_bounded) {
  const auto task = ParseArgs({L"record-task", L"--policy", L"p.json", L"--output-dir", L"recording", L"--input-hooks"});
  CHECK(task.command && task.command->kind == cli::CommandKind::RecordTask && task.command->seconds == 1200);
  CHECK(ParseArgs({L"record-task", L"--policy", L"p", L"--output-dir", L"out", L"--seconds", L"1201"}).error == "invalid_seconds");
  CHECK(ParseArgs({L"record-task", L"--policy", L"p"}).error == "missing_output_directory");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--output-dir", L"out"}).error == "unknown_option");
  CHECK(ParseArgs({L"export-task-frames", L"--output-dir", L"out"}).error == "missing_export_directory");
  CHECK(ParseArgs({L"finalize-task", L"--output-dir", L"out"}).command->kind == cli::CommandKind::FinalizeTask);
}

TEST(cli_test_options_exist_only_in_test_builds) {
  CHECK(ParseArgs({L"snapshot", L"--hwnd", L"5", L"--policy", L"p", L"--test-worker-sleep-ms", L"10"}).error ==
        "unknown_option");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--test-gate", L"Local\\memmy-history-test-x"}).error ==
        "unknown_option");
  auto r = ParseArgs({L"snapshot", L"--hwnd", L"5", L"--policy", L"p", L"--test-worker-sleep-ms", L"10", L"--test-gate",
                      L"Local\\memmy-history-test-x"},
                     true);
  CHECK(r.command && r.command->test.workerSleepMs == 10 && r.command->test.gate == L"Local\\memmy-history-test-x");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--test-gate", L"Global\\x"}, true).error == "invalid_test_option");
  CHECK(ParseArgs({L"observe", L"--policy", L"p", L"--test-gate", L"Local\\memmy-history-test-a\\b"}, true).error ==
        "invalid_test_option");
}

TEST(argument_quoting_round_trips_through_commandlinetoargvw) {
  const std::vector<std::wstring> samples = {L"plain", L"with space", L"D:\\空 格\\a.exe", L"trailing\\",
                                             L"trail space\\", L"quote\"inside", L"back\\\\\"slash", L"", L"tab\tx"};
  for (const auto& sample : samples) {
    const std::wstring line = L"x.exe " + cli::QuoteArgument(sample);
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(line.c_str(), &argc);
    CHECK(argv != nullptr && argc == 2 && sample == argv[1]);
    LocalFree(argv);
  }
}

TEST(control_lines_are_bounded_and_exact) {
  CHECK(cli::ParseControlCommand("pause") == cli::ControlCommand::Pause);
  CHECK(cli::ParseControlCommand(" resume\t") == cli::ControlCommand::Resume);
  CHECK(cli::ParseControlCommand("stop") == cli::ControlCommand::Stop);
  CHECK(cli::ParseControlCommand("STOP") == cli::ControlCommand::Unknown);
  CHECK(cli::ParseControlCommand("pause now") == cli::ControlCommand::Unknown);
  cli::LineSplitter splitter(8);
  std::vector<std::string> lines;
  splitter.Feed("pau", 3, lines);
  splitter.Feed("se\r\nresume\n", 11, lines);
  CHECK((lines == std::vector<std::string>{"pause", "resume"}));
  lines.clear();
  const std::string longLine = std::string(100, 'x') + "\nstop\n";
  splitter.Feed(longLine.data(), longLine.size(), lines);
  CHECK((lines == std::vector<std::string>{"stop"}));
  CHECK(splitter.Overlong() == 1);
}

}  // namespace

int main() {
  int failedTests = 0;
  for (const auto& test : Registry()) {
    g_current = test.name;
    const int before = g_failures;
    try {
      test.body();
    } catch (const std::exception& error) {
      ++g_failures;
      std::fprintf(stderr, "  FAIL [%s] exception: %s\n", test.name, error.what());
    }
    const bool passed = g_failures == before;
    if (!passed) ++failedTests;
    std::printf("%s %s\n", passed ? "PASS" : "FAIL", test.name);
  }
  std::printf("%zu tests, %d failed, %d failed checks\n", Registry().size(), failedTests, g_failures);
  return failedTests == 0 ? 0 : 1;
}
