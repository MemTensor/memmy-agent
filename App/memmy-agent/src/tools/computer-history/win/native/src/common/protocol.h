#pragma once

#include "common/json.h"
#include "common/policy.h"

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace memmy::protocol {

inline constexpr const char* kProtocolName = "memmy.windows.computer-history";
inline constexpr int kProtocolVersion = 1;
inline constexpr const char* kPlatform = "windows";
inline constexpr const char* kWorkerProtocol = "memmy.windows.history-worker/1";
inline constexpr std::size_t kMaxWorkerRequestBytes = 512 * 1024;
inline constexpr std::size_t kMaxWorkerResponseBytes = 8 * 1024 * 1024;

// "2026-10-01T12:34:56.789Z" from FILETIME ticks (100 ns since 1601-01-01 UTC).
std::string FormatUtcTimestamp(std::uint64_t filetimeTicks);

bool IsKnownReason(std::string_view reason);

struct NodeRecord {
  std::string runtimeId;
  long controlType = 0;
  std::string automationId;
  std::optional<std::string> className;
  int depth = 0;
  int parent = -1;  // index of the parent node in the same snapshot, -1 for the root
  bool focused = false;
  bool providerOffscreen = false;
  std::optional<bool> password;  // nullopt: provider did not report IsPassword
  std::string redaction;         // empty when content was permitted
  std::string documentStatus;    // scoped editor only: available | label_only | read_failed
  std::optional<std::string> name;
  std::optional<std::string> text;
  std::optional<std::string> visibleText;
  std::optional<std::string> value;
  std::optional<std::array<double, 4>> bounds;  // left, top, width, height (physical px)
  std::vector<std::string> missing;             // properties that failed to read
};

// Fixed VS Code shape: Edit("") <- Text("") <- Group("") <- Group(workbench.parts.editor).
// Parents must precede the node, be readable and have successfully read AutomationIds.
bool IsVsCodeEditorBody(const NodeRecord& node, const std::vector<NodeRecord>& preceding, const policy::AppRule& rule);
bool IsWordDocument(const NodeRecord& node, const std::vector<NodeRecord>& preceding, const policy::AppRule& rule);
bool IsNotepadDocument(const NodeRecord& node, const std::vector<NodeRecord>& preceding, const policy::AppRule& rule);
void FinalizeScopedDocument(NodeRecord& node);

// Stable content key (FNV-1a 64, hex) over identity and content fields. Focus, bounds and the
// provider offscreen flag are excluded so they do not churn deltas.
std::string NodeKey(const NodeRecord& node, std::string_view parentKey = {});
// Parent-dependent keys ensure that changed ancestors also resend unchanged descendants.
std::vector<std::string> NodeKeys(const std::vector<NodeRecord>& nodes);

struct ContextRecord {
  std::uint64_t hwnd = 0;
  std::uint32_t pid = 0;
  std::uint64_t processStart = 0;
  std::string executable;
  std::uint32_t dpi = 0;
  std::array<std::int32_t, 4> bounds{};  // left, top, right, bottom
  bool minimized = false;
  std::optional<std::string> title;
};

Json ContextToJson(const ContextRecord& context, std::optional<std::uint64_t> generation);
bool SameInstance(const ContextRecord& left, const ContextRecord& right);

struct SnapshotStats {
  std::uint64_t visited = 0;
  std::uint64_t emitted = 0;
  std::uint64_t redacted = 0;
  std::uint64_t foreignSkipped = 0;
  std::uint64_t missingProperties = 0;
};

struct WorkerRequest {
  std::uint64_t hwnd = 0;
  std::uint32_t pid = 0;
  std::uint64_t processStart = 0;
  std::string executable;
  std::string policyText;
  std::uint32_t testSleepMs = 0;
  std::string testGate;
};

Json WorkerRequestToJson(const WorkerRequest& request);
bool WorkerRequestFromJson(const Json& json, bool allowTestFields, WorkerRequest& out);

struct WorkerResponse {
  std::string status;  // ok | blocked | unavailable
  std::string reason;
  std::optional<ContextRecord> context;
  std::vector<NodeRecord> nodes;
  bool truncated = false;
  std::vector<std::string> truncation;
  SnapshotStats stats;
  double elapsedMs = 0;
};

Json WorkerResponseToJson(const WorkerResponse& response);

// Strict validation of an untrusted worker response against the request and policy limits,
// including privacy invariants: redacted nodes carry no content, content only appears where
// the classifier permits it, and no node descends from a node whose subtree is blocked.
bool WorkerResponseFromJson(const Json& json, const policy::Policy& policy, const policy::AppRule& rule,
                            WorkerResponse& out, std::string& error);

Json NodeToJson(const NodeRecord& node, const std::string* key, const std::string* parentKey);

}  // namespace memmy::protocol
