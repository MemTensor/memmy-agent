#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace memmy::policy {

inline constexpr std::size_t kMaxPolicyBytes = 256 * 1024;

// Ordinary selectors match exact control type and nonempty AutomationId. The explicit
// VS Code scope also checks a fixed ancestor chain before content; names never grant access.
struct ElementSelector {
  long controlType = 0;
  std::wstring automationId;
  bool vscodeEditor = false;  // fixed, bounded ancestry; never a wildcard empty AutomationId
  bool wordDocument = false;
  bool notepadDocument = false;
};

struct AppRule {
  std::uint32_t pid = 0;
  std::wstring executable;  // absolute path as written; canonicalized at evaluation
  std::optional<std::uint64_t> processStart;  // FILETIME ticks (100 ns since 1601 UTC)
  std::optional<std::uint64_t> hwnd;
  std::vector<ElementSelector> searchFields;     // Edit only; read only while focused
  std::vector<ElementSelector> documentRegions;  // Document or Edit body regions
  std::vector<std::wstring> sensitiveAutomationIds;
};

struct Limits {
  int maxDepth = 24;
  int maxNodes = 400;
  int maxVisited = 2000;
  int maxTextChars = 12000;
  int maxNodeTextChars = 2048;
  int queryBudgetMs = 650;
  int workerTimeoutMs = 1500;
};

struct Policy {
  std::vector<AppRule> applications;
  std::vector<std::wstring> deniedExecutables;
  std::vector<std::uint32_t> deniedPids;
  std::vector<std::wstring> sensitiveAutomationIds;
  Limits limits;
};

// Error codes and JSON paths only; policy values are never echoed.
struct ParseError {
  std::string code;
  std::string path;
};

struct ParseResult {
  std::optional<Policy> policy;
  ParseError error;
};

ParseResult Parse(std::string_view utf8);

struct Target {
  std::uint32_t pid = 0;
  std::uint64_t processStart = 0;
  std::uint64_t hwnd = 0;
  std::wstring executable;  // canonical path of the running image
};

enum class Verdict { Allowed, Denied, BrowserUnsupported, NotAuthorized };

struct Decision {
  Verdict verdict = Verdict::NotAuthorized;
  const AppRule* rule = nullptr;  // set for Allowed and for a matched BrowserUnsupported rule
  const char* reason = "application_not_authorized";
};

using Canonicalizer = std::function<std::wstring(const std::wstring&)>;

// Deny always wins, then the known-browser gate, then the exact application rules.
Decision Evaluate(const Policy& policy, const Target& target, const Canonicalizer& canonicalize);

// Basename match against known browser and browser-host executables. Used only to refuse
// capture, never to grant it.
bool IsKnownBrowserExecutable(std::wstring_view executablePath);

bool IsSensitiveAutomationId(const Policy& policy, const AppRule& rule, std::wstring_view automationId);
bool MatchesSelector(const std::vector<ElementSelector>& selectors, long controlType,
                     std::wstring_view automationId);
bool HasVsCodeEditorScope(const AppRule& rule);
bool HasWordDocumentScope(const AppRule& rule);
bool HasNotepadDocumentScope(const AppRule& rule);

}  // namespace memmy::policy
