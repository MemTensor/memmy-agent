#pragma once

#include <optional>
#include <string_view>

namespace memmy::policy {
struct Policy;
struct AppRule;
}  // namespace memmy::policy

namespace memmy::classify {

// UIA control type ids (UIAutomationClient.h, UIA_*ControlTypeId). Values are part of the
// public UIA contract; duplicated here so pure logic does not depend on COM headers.
inline constexpr long kButton = 50000;
inline constexpr long kComboBox = 50003;
inline constexpr long kEdit = 50004;
inline constexpr long kText = 50020;
inline constexpr long kCustom = 50025;
inline constexpr long kGroup = 50026;
inline constexpr long kDocument = 50030;
inline constexpr long kWindow = 50032;
inline constexpr long kPane = 50033;

// Name for a UIA control type id, or nullptr when the id is not a known UIA control type.
const char* ControlTypeName(long controlType);
std::optional<long> ControlTypeFromName(std::string_view name);
// Containers whose own content can be masked while each child is checked independently.
bool IsStructural(long controlType);

enum class PasswordState { False, True, Unknown };

// Metadata read before any content property. Name/value/text are never inputs.
struct NodeFacts {
  long controlType = 0;
  PasswordState password = PasswordState::Unknown;
  std::wstring_view automationId;
  bool hasKeyboardFocus = false;
  bool textPatternAvailable = false;
  bool valuePatternAvailable = false;
  bool scopedDocument = false;  // derived locally from verified ancestors, never taken from wire content
};

enum class Redaction {
  None,
  SensitiveId,       // explicit sensitive AutomationId (global or per application)
  Password,          // IsPassword = true
  EditControl,       // ordinary input; value, name and descendants are never read
  UnknownPassword,   // IsPassword not supported on a content-bearing control
  UnknownStructural  // IsPassword not supported on a container: masked, children checked
};

struct NodeDecision {
  Redaction redaction = Redaction::None;
  bool readName = false;
  bool readDocumentText = false;  // TextPattern DocumentRange + visible ranges
  bool readSearchValue = false;   // ValuePattern, focused exact search selector only
  bool traverseChildren = false;
};

NodeDecision Classify(const NodeFacts& facts, const policy::Policy& policy, const policy::AppRule& rule);
const char* RedactionCode(Redaction redaction);
std::optional<Redaction> RedactionFromCode(std::string_view code);

}  // namespace memmy::classify
