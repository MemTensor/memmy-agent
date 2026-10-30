#include "common/classify.h"

#include "common/policy.h"

#include <array>
#include <utility>

namespace memmy::classify {
namespace {

constexpr long kFirstControlType = 50000;
constexpr std::array<const char*, 41> kControlTypeNames = {
    "Button",   "Calendar",  "CheckBox",  "ComboBox",  "Edit",       "Hyperlink",   "Image",
    "ListItem", "List",      "Menu",      "MenuBar",   "MenuItem",   "ProgressBar", "RadioButton",
    "ScrollBar", "Slider",   "Spinner",   "StatusBar", "Tab",        "TabItem",     "Text",
    "ToolBar",  "ToolTip",   "Tree",      "TreeItem",  "Custom",     "Group",       "Thumb",
    "DataGrid", "DataItem",  "Document",  "SplitButton", "Window",   "Pane",        "Header",
    "HeaderItem", "Table",   "TitleBar",  "Separator", "SemanticZoom", "AppBar"};

constexpr std::array<std::pair<Redaction, const char*>, 5> kRedactionCodes = {{
    {Redaction::SensitiveId, "sensitive_id"},
    {Redaction::Password, "password"},
    {Redaction::EditControl, "edit_control"},
    {Redaction::UnknownPassword, "unknown_password"},
    {Redaction::UnknownStructural, "unknown_password_structural"},
}};

}  // namespace

const char* ControlTypeName(long controlType) {
  if (controlType < kFirstControlType || controlType >= kFirstControlType + static_cast<long>(kControlTypeNames.size())) {
    return nullptr;
  }
  return kControlTypeNames[static_cast<std::size_t>(controlType - kFirstControlType)];
}

std::optional<long> ControlTypeFromName(std::string_view name) {
  for (std::size_t i = 0; i < kControlTypeNames.size(); ++i) {
    if (name == kControlTypeNames[i]) return kFirstControlType + static_cast<long>(i);
  }
  return std::nullopt;
}

bool IsStructural(long controlType) {
  switch (controlType) {
    case kWindow:
    case kPane:
    case kGroup:
    case kCustom:
    case 50010:  // MenuBar
    case 50017:  // StatusBar
    case 50018:  // Tab
    case 50021:  // ToolBar
    case 50008:  // List
    case 50023:  // Tree
    case 50028:  // DataGrid
    case 50034:  // Header
    case 50036:  // Table
    case 50037:  // TitleBar
    case 50039:  // SemanticZoom
    case 50040:  // AppBar
      return true;
    default:
      return false;
  }
}

NodeDecision Classify(const NodeFacts& facts, const policy::Policy& policy, const policy::AppRule& rule) {
  NodeDecision decision;
  // Sensitive markers and passwords block the node and its entire subtree.
  if (policy::IsSensitiveAutomationId(policy, rule, facts.automationId)) {
    decision.redaction = Redaction::SensitiveId;
    return decision;
  }
  if (facts.password == PasswordState::True) {
    decision.redaction = Redaction::Password;
    return decision;
  }
  if (facts.controlType == kEdit) {
    if (facts.password == PasswordState::Unknown) {
      decision.redaction = Redaction::UnknownPassword;
      return decision;
    }
    // An exact, explicitly authorized body region (e.g. an editor surface exposed as Edit).
    if (facts.textPatternAvailable &&
        (policy::MatchesSelector(rule.documentRegions, facts.controlType, facts.automationId) ||
         (facts.scopedDocument && policy::HasVsCodeEditorScope(rule)))) {
      decision.readName = true;
      decision.readDocumentText = true;
      return decision;
    }
    if (facts.hasKeyboardFocus && facts.valuePatternAvailable &&
        policy::MatchesSelector(rule.searchFields, facts.controlType, facts.automationId)) {
      decision.readName = true;
      decision.readSearchValue = true;
      return decision;
    }
    // Ordinary input: no name, value or text, and no descendants (child Text can mirror input).
    decision.redaction = Redaction::EditControl;
    return decision;
  }
  if (facts.password == PasswordState::Unknown) {
    if (IsStructural(facts.controlType)) {
      decision.redaction = Redaction::UnknownStructural;
      decision.traverseChildren = true;
      return decision;
    }
    decision.redaction = Redaction::UnknownPassword;
    return decision;
  }
  // VS Code mirrors private input into sibling live-region/status labels. The bounded
  // editor adapter authorizes bodies, not arbitrary workbench names (including Text).
  decision.readName = !policy::HasVsCodeEditorScope(rule);
  if (facts.controlType == kDocument && facts.textPatternAvailable &&
      (policy::MatchesSelector(rule.documentRegions, facts.controlType, facts.automationId) ||
       (facts.scopedDocument && (policy::HasWordDocumentScope(rule) || policy::HasNotepadDocumentScope(rule))))) {
    // The authorized body is read as one range; its children would only duplicate it.
    decision.readName = true;
    decision.readDocumentText = true;
    return decision;
  }
  decision.traverseChildren = true;
  return decision;
}

const char* RedactionCode(Redaction redaction) {
  for (const auto& [value, code] : kRedactionCodes) {
    if (value == redaction) return code;
  }
  return nullptr;
}

std::optional<Redaction> RedactionFromCode(std::string_view code) {
  for (const auto& [value, name] : kRedactionCodes) {
    if (code == name) return value;
  }
  return std::nullopt;
}

}  // namespace memmy::classify
