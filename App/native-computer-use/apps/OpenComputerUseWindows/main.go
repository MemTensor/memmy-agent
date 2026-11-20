package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var clickMethodValues = []string{"auto", "accessibility", "app_post", "sky_click", "global"}

//go:embed runtime.ps1
var windowsRuntimeScript string

const serverInstructions = "Computer Use tools let you interact with Windows apps by performing UI actions.\n\nBegin by calling `get_app_state` every turn you want to use Computer Use to get the latest state before acting. The available tools are list_apps, get_app_state, click, perform_secondary_action, scroll, drag, type_text, press_key, and set_value. `list_apps` only lists running processes with top-level windows, not recently used apps. Choose its exact app identifier, installed app name, process name or PID for the app argument; window and document titles are not app identity. `get_app_state` also accepts an installed app name and opens it from the Start menu when it is not running or has no window.\n\nPrefer element-targeted UI Automation interactions over coordinate clicks when an index for the targeted element is available. Coordinate clicks, drags, scrolling, and typing use verified target window messages without activating the target or moving the physical pointer. Window messages do not reach Chromium pages, carry text only into native edit controls, and carry no modifier state. The one exception is click, type_text and press_key with foreground=true: it waits for a pause in the user's input, brings the target window to the front, sends real input, then returns the previous window (and, for a click, the pointer). Choose it when background input cannot reach the target; it briefly takes the user's foreground. Unsupported background input returns an error. Temporary user input yields; re-observe before continuing, and never replay an uncertain action. Screenshots come from the target window, including when another window covers it; an unavailable capture is not replaced by a screen copy. Window, element and image changes require a fresh observation before acting. The Windows runtime does not perform SetFocus or use UIA text fallback by default."

type toolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Annotations map[string]any `json:"annotations,omitempty"`
	InputSchema map[string]any `json:"inputSchema"`
}

type contentItem struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type toolCallResult struct {
	Content []contentItem  `json:"content"`
	IsError bool           `json:"isError"`
	Meta    map[string]any `json:"_meta,omitempty"`
}

func textResult(text string, isError bool) toolCallResult {
	return toolCallResult{Content: []contentItem{{Type: "text", Text: text}}, IsError: isError}
}

type appDescriptor struct {
	Name             string `json:"name"`
	BundleIdentifier string `json:"bundleIdentifier,omitempty"`
	PID              int    `json:"pid"`
}

type frame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (f frame) renderedLocalFrame() string {
	return fmt.Sprintf("{{x: %.0f, y: %.0f, width: %.0f, height: %.0f}}", f.X, f.Y, f.Width, f.Height)
}

type elementRecord struct {
	Index                int      `json:"index"`
	RuntimeID            []int    `json:"runtimeId,omitempty"`
	AutomationID         string   `json:"automationId,omitempty"`
	Name                 string   `json:"name,omitempty"`
	ControlType          string   `json:"controlType,omitempty"`
	LocalizedControlType string   `json:"localizedControlType,omitempty"`
	ClassName            string   `json:"className,omitempty"`
	Value                string   `json:"value,omitempty"`
	NativeWindowHandle   int64    `json:"nativeWindowHandle,omitempty"`
	Frame                *frame   `json:"frame,omitempty"`
	Actions              []string `json:"actions,omitempty"`
	StateSignature       string   `json:"stateSignature,omitempty"`
	ContextProof         string   `json:"contextProof,omitempty"`
	ContextScoped        bool     `json:"contextScoped,omitempty"`
}

type observedWindow struct {
	WindowID  int64  `json:"windowID"`
	Title     string `json:"title,omitempty"`
	IsFocused bool   `json:"isFocused"`
}

type appSnapshot struct {
	KeyboardReceiverID        int64            `json:"keyboardReceiverID,omitempty"`
	KeyboardReceiverRuntimeID []int            `json:"keyboardReceiverRuntimeID,omitempty"`
	KeyboardReceiverState     string           `json:"keyboardReceiverState,omitempty"`
	TargetWindowID            int64            `json:"targetWindowID,omitempty"`
	ObservationID             string           `json:"observationID,omitempty"`
	AvailableWindows          []observedWindow `json:"availableWindows,omitempty"`
	RelatedWindowIDs          []int64          `json:"relatedWindowIDs,omitempty"`
	CaptureGroupProof         string           `json:"captureGroupProof,omitempty"`
	ScreenshotIsolated        bool             `json:"screenshotIsolated,omitempty"`
	AccessibilityTreeComplete bool             `json:"accessibilityTreeComplete,omitempty"`
	ObservationNote           string           `json:"-"`
	renderRequest             psRequest
	pointerDelivery           string
	foregroundClick           string
	App                       appDescriptor   `json:"app"`
	WindowTitle               string          `json:"windowTitle,omitempty"`
	WindowBounds              *frame          `json:"windowBounds,omitempty"`
	ScreenshotPNGBase64       string          `json:"screenshotPngBase64,omitempty"`
	TreeLines                 []string        `json:"treeLines,omitempty"`
	FocusedSummary            string          `json:"focusedSummary,omitempty"`
	SelectedText              string          `json:"selectedText,omitempty"`
	Elements                  []elementRecord `json:"elements,omitempty"`
}

func (s *appSnapshot) renderedText() string {
	if s == nil {
		return ""
	}
	appRef := s.App.BundleIdentifier
	if appRef == "" {
		appRef = s.App.Name
	}
	title := s.WindowTitle
	if strings.TrimSpace(title) == "" {
		title = s.App.Name
	}

	lines := []string{
		fmt.Sprintf("App=%s (pid %d)", appRef, s.App.PID),
		fmt.Sprintf("Window: %q, App: %s.", title, s.App.Name),
	}
	if s.TargetWindowID > 0 {
		lines = append(lines, fmt.Sprintf("Window ID=%d", s.TargetWindowID))
	}
	if s.ObservationID != "" {
		lines = append(lines, "Observation ID="+s.ObservationID)
	}
	if len(s.AvailableWindows) > 0 {
		lines = append(lines, "Available windows (select with get_app_state app/window_id):")
		for _, window := range s.AvailableWindows {
			flags := ""
			if window.IsFocused {
				flags = " [focused]"
			}
			lines = append(lines, fmt.Sprintf("- window_id=%d %s%s", window.WindowID, strings.ReplaceAll(window.Title, "\n", " "), flags))
		}
	}
	if s.ObservationNote != "" {
		lines = append(lines, s.ObservationNote)
	}
	lines = append(lines, s.TreeLines...)
	if strings.TrimSpace(s.SelectedText) != "" {
		lines = append(lines, "", fmt.Sprintf("Selected text: [%s]", s.SelectedText))
	} else if strings.TrimSpace(s.FocusedSummary) != "" {
		lines = append(lines, "", fmt.Sprintf("The focused UI element is %s.", s.FocusedSummary))
	}
	return strings.Join(lines, "\n")
}

func (s *appSnapshot) result() toolCallResult {
	result := toolCallResult{
		Content: []contentItem{{Type: "text", Text: s.renderedText()}},
	}
	if s != nil && s.ScreenshotPNGBase64 != "" {
		result.Content = append(result.Content, contentItem{
			Type:     "image",
			Data:     s.ScreenshotPNGBase64,
			MimeType: "image/png",
		})
	}
	result.Meta = map[string]any{"memmyComputerUse": map[string]any{
		"targetWindowID": s.TargetWindowID, "pid": s.App.PID, "observationID": s.ObservationID,
		"availableWindows": s.AvailableWindows, "windowBounds": s.WindowBounds,
		"relatedWindowIDs":   append([]int64{}, s.RelatedWindowIDs...),
		"screenshotIsolated": s.ScreenshotIsolated && s.ScreenshotPNGBase64 != "",
	}}
	return result
}

type psRequest struct {
	ctx                               context.Context
	DeadlineEpochMs                   int64          `json:"deadline_epoch_ms,omitempty"`
	ObservedKeyboardReceiverID        int64          `json:"observed_keyboard_receiver_id,omitempty"`
	ObservedKeyboardReceiverRuntimeID []int          `json:"observed_keyboard_receiver_runtime_id,omitempty"`
	WindowID                          int64          `json:"window_id,omitempty"`
	RelatedWindowIDs                  []int64        `json:"related_window_ids,omitempty"`
	ObservedCaptureGroupProof         string         `json:"observed_capture_group_proof,omitempty"`
	ExpectedPID                       int            `json:"expected_pid,omitempty"`
	ExpectedAppID                     string         `json:"expected_app_id,omitempty"`
	Tool                              string         `json:"tool"`
	App                               string         `json:"app,omitempty"`
	Element                           *elementRecord `json:"element,omitempty"`
	X                                 *float64       `json:"x,omitempty"`
	Y                                 *float64       `json:"y,omitempty"`
	FromX                             *float64       `json:"from_x,omitempty"`
	FromY                             *float64       `json:"from_y,omitempty"`
	ToX                               *float64       `json:"to_x,omitempty"`
	ToY                               *float64       `json:"to_y,omitempty"`
	ClickCount                        int            `json:"click_count,omitempty"`
	MouseButton                       string         `json:"mouse_button,omitempty"`
	ClickMethod                       string         `json:"click_method,omitempty"`
	Foreground                        bool           `json:"foreground,omitempty"`
	Action                            string         `json:"action,omitempty"`
	Direction                         string         `json:"direction,omitempty"`
	Pages                             float64        `json:"pages,omitempty"`
	Text                              string         `json:"text,omitempty"`
	Key                               string         `json:"key,omitempty"`
	Value                             string         `json:"value,omitempty"`
	WindowBounds                      *frame         `json:"windowBounds,omitempty"`
	TextLimit                         any            `json:"text_limit,omitempty"`
	MaxTreeNodes                      int            `json:"max_tree_nodes,omitempty"`
	MaxTreeDepth                      int            `json:"max_tree_depth,omitempty"`
	// The state verified immediately before the action, for comparing its result.
	observed *appSnapshot
}

type textLimit struct {
	max   bool
	count int
}

func (limit textLimit) runtimeValue() any {
	if limit.max {
		return "max"
	}
	return limit.count
}

type psResponse struct {
	FocusChangedByApp       bool               `json:"focusChangedByApp,omitempty"`
	OK                      bool               `json:"ok"`
	Text                    string             `json:"text,omitempty"`
	Error                   string             `json:"error,omitempty"`
	FocusGuardStop          bool               `json:"focusGuardStop,omitempty"`
	FocusGuardYield         bool               `json:"focusGuardYield,omitempty"`
	Dispatched              bool               `json:"dispatched,omitempty"`
	TargetWindowUnavailable bool               `json:"targetWindowUnavailable,omitempty"`
	RequestedWindowID       int64              `json:"requestedWindowID,omitempty"`
	PID                     int                `json:"pid,omitempty"`
	AvailableWindows        []observedWindow   `json:"availableWindows,omitempty"`
	FocusState              *windowsFocusState `json:"focusState,omitempty"`
	Success                 bool               `json:"success,omitempty"`
	Snapshot                *appSnapshot       `json:"snapshot,omitempty"`
	RunningApps             *runningAppListing `json:"runningApps,omitempty"`
	Resolution              *appResolution     `json:"resolution,omitempty"`
	PointerDelivery         string             `json:"pointerDelivery,omitempty"`
	ForegroundClick         string             `json:"foregroundClick,omitempty"`
}

type resolvedApp struct {
	AppID       string `json:"appId"`
	DisplayName string `json:"displayName"`
}

// Same JSON contract as the macOS resolve-app command; pid is set only when
// one running window of the app can be bound exactly.
type appResolution struct {
	Platform string       `json:"platform"`
	Status   string       `json:"status"`
	App      *resolvedApp `json:"app,omitempty"`
	PID      int          `json:"pid,omitempty"`
}

type runningAppIdentity struct {
	AppID       string   `json:"appId"`
	DisplayName string   `json:"displayName"`
	ProcessName string   `json:"processName"`
	PID         int      `json:"pid"`
	Aliases     []string `json:"aliases,omitempty"`
}

type runningAppListing struct {
	Version int                  `json:"version"`
	Apps    []runningAppIdentity `json:"apps"`
}

type service struct {
	ctx              context.Context
	snapshots        map[string]*appSnapshot
	windows          map[windowKey]*appSnapshot
	windowOrder      []windowKey
	observations     map[string]*appSnapshot
	observationOrder []string
	binding          observationBinding
	confirmedRetry   *coordinateRetry
	runner           func(psRequest) (*psResponse, error)
}

func newService() *service {
	return &service{snapshots: map[string]*appSnapshot{}, windows: map[windowKey]*appSnapshot{}, observations: map[string]*appSnapshot{}, runner: runPowerShell}
}

func (s *service) callTool(name string, args map[string]any) toolCallResult {
	if name != "list_apps" {
		binding, err := parseObservationBinding(args)
		if err != nil {
			return textResult(err.Error(), true)
		}
		previous := s.binding
		if binding.DeadlineEpochMs == 0 {
			binding.DeadlineEpochMs = time.Now().Add(30 * time.Second).UnixMilli()
		}
		s.binding = binding
		defer func() { s.binding = previous }()
	}
	switch name {
	case "list_apps":
		return s.listApps()
	case "get_app_state":
		maxTreeNodes, err := optionalPositiveInt(args, "max_tree_nodes")
		if err != nil {
			return textResult(err.Error(), true)
		}
		maxTreeDepth, err := optionalPositiveInt(args, "max_tree_depth")
		if err != nil {
			return textResult(err.Error(), true)
		}
		textLimit, err := optionalTextLimit(args, "text_limit")
		if err != nil {
			return textResult(err.Error(), true)
		}
		return s.getAppState(requiredString(args, "app"), textLimit, maxTreeNodes, maxTreeDepth)
	case "click":
		clickMethod, err := parseClickMethod(optionalString(args, "click_method"))
		if err != nil {
			return textResult(err.Error(), true)
		}
		foreground, err := optionalBool(args, "foreground")
		if err != nil {
			return textResult(err.Error(), true)
		}
		return s.click(
			requiredString(args, "app"),
			optionalElementIndex(args),
			optionalFloat(args, "x"),
			optionalFloat(args, "y"),
			intValue(optionalFloat(args, "click_count"), 1),
			defaultString(optionalString(args, "mouse_button"), "left"),
			clickMethod,
			foreground,
		)
	case "perform_secondary_action":
		return s.performSecondaryAction(
			requiredString(args, "app"),
			requiredElementIndex(args),
			requiredString(args, "action"),
		)
	case "scroll":
		return s.scroll(
			requiredString(args, "app"),
			requiredString(args, "direction"),
			optionalElementIndex(args),
			optionalFloat(args, "x"),
			optionalFloat(args, "y"),
			floatValue(optionalFloat(args, "pages"), 1),
		)
	case "drag":
		return s.drag(
			requiredString(args, "app"),
			requiredFloat(args, "from_x"),
			requiredFloat(args, "from_y"),
			requiredFloat(args, "to_x"),
			requiredFloat(args, "to_y"),
		)
	case "type_text", "press_key":
		foreground, err := optionalBool(args, "foreground")
		if err != nil {
			return textResult(err.Error(), true)
		}
		if name == "type_text" {
			return s.typeText(requiredString(args, "app"), requiredString(args, "text"), foreground)
		}
		return s.pressKey(requiredString(args, "app"), requiredString(args, "key"), foreground)
	case "set_value":
		return s.setValue(requiredString(args, "app"), requiredElementIndex(args), requiredString(args, "value"))
	default:
		return textResult(fmt.Sprintf("unsupportedTool(%q)", name), true)
	}
}

func (s *service) listApps() toolCallResult {
	response, err := s.runner(psRequest{Tool: "list_apps"})
	if err != nil {
		return textResult(err.Error(), true)
	}
	if !response.OK {
		return textResult(response.Error, true)
	}
	if strings.TrimSpace(response.Text) == "" {
		response.Text = "No running top-level apps are visible to this Windows runtime."
	}
	result := textResult(response.Text, false)
	if response.RunningApps != nil {
		result.Meta = map[string]any{"memmyComputerUse": map[string]any{"runningApps": response.RunningApps}}
	}
	return result
}

func (s *service) getAppState(app string, textLimit *textLimit, maxTreeNodes, maxTreeDepth *int) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	request := psRequest{Tool: "get_app_state", App: app, WindowID: s.binding.WindowID}
	if textLimit != nil {
		request.TextLimit = textLimit.runtimeValue()
	}
	if maxTreeNodes != nil {
		request.MaxTreeNodes = *maxTreeNodes
	}
	if maxTreeDepth != nil {
		request.MaxTreeDepth = *maxTreeDepth
	}
	snapshot, result := s.refreshSnapshot(app, request)
	if result.IsError {
		return result
	}
	return snapshot.result()
}

func (s *service) click(app, elementIndex string, x, y *float64, clickCount int, mouseButton, clickMethod string, foreground bool) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if elementIndex == "" && (x == nil || y == nil) {
		return textResult("click requires either element_index or x/y", true)
	}
	if clickMethod == "accessibility" && elementIndex == "" {
		return textResult("click_method 'accessibility' requires element_index", true)
	}
	if clickMethod == "global" {
		return textResult("click_method 'global' is not supported on Windows", true)
	}
	if clickMethod == "sky_click" {
		return textResult("click_method 'sky_click' is not supported on Windows", true)
	}
	if foreground && clickMethod == "accessibility" {
		return textResult("foreground=true sends a pointer click; use click_method auto or app_post", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	request := psRequest{
		Tool:         "click",
		App:          app,
		X:            x,
		Y:            y,
		ClickCount:   clickCount,
		MouseButton:  mouseButton,
		ClickMethod:  clickMethod,
		Foreground:   foreground,
		WindowBounds: snapshot.WindowBounds,
	}
	if elementIndex != "" {
		record, err := lookupElement(snapshot, elementIndex)
		if err != nil {
			return textResult(err.Error(), true)
		}
		request.Element = record
	}
	return s.actionResult(app, request)
}

func (s *service) performSecondaryAction(app, elementIndex, action string) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if elementIndex == "" {
		return textResult("Missing required argument: element_index", true)
	}
	if action == "" {
		return textResult("Missing required argument: action", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	record, err := lookupElement(snapshot, elementIndex)
	if err != nil {
		return textResult(err.Error(), true)
	}
	return s.actionResult(app, psRequest{Tool: "perform_secondary_action", App: app, Element: record, Action: action})
}

func (s *service) scroll(app, direction, elementIndex string, x, y *float64, pages float64) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if (x == nil) != (y == nil) {
		return textResult("scroll requires both x and y", true)
	}
	if elementIndex == "" && x == nil {
		return textResult("scroll requires either element_index or x/y", true)
	}
	if elementIndex != "" && x != nil {
		return textResult("scroll accepts either element_index or x/y, not both", true)
	}
	normalized := strings.ToLower(direction)
	if normalized != "up" && normalized != "down" && normalized != "left" && normalized != "right" {
		return textResult("Invalid scroll direction: "+direction, true)
	}
	if math.IsNaN(pages) || math.IsInf(pages, 0) || pages <= 0 {
		return textResult("pages must be > 0", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	if x != nil {
		if snapshot.WindowBounds == nil ||
			math.IsNaN(*x) || math.IsInf(*x, 0) || math.IsNaN(*y) || math.IsInf(*y, 0) ||
			*x < 0 || *y < 0 || *x >= snapshot.WindowBounds.Width || *y >= snapshot.WindowBounds.Height {
			return textResult("scroll coordinates are outside the current app screenshot", true)
		}
		return s.actionResult(app, psRequest{Tool: "scroll", App: app, X: x, Y: y,
			WindowBounds: snapshot.WindowBounds, Direction: normalized, Pages: pages})
	}
	record, err := lookupElement(snapshot, elementIndex)
	if err != nil {
		return textResult(err.Error(), true)
	}
	return s.actionResult(app, psRequest{Tool: "scroll", App: app, Element: record, Direction: normalized, Pages: pages})
}

func (s *service) drag(app string, fromX, fromY, toX, toY *float64) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if fromX == nil {
		return textResult("Missing required argument: from_x", true)
	}
	if fromY == nil {
		return textResult("Missing required argument: from_y", true)
	}
	if toX == nil {
		return textResult("Missing required argument: to_x", true)
	}
	if toY == nil {
		return textResult("Missing required argument: to_y", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	return s.actionResult(app, psRequest{Tool: "drag", App: app, FromX: fromX, FromY: fromY, ToX: toX, ToY: toY, WindowBounds: snapshot.WindowBounds})
}

func (s *service) typeText(app, text string, foreground bool) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if text == "" {
		return textResult("Missing required argument: text", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	return s.actionResult(app, psRequest{Tool: "type_text", App: app, Text: text, Foreground: foreground, WindowBounds: snapshot.WindowBounds})
}

func (s *service) pressKey(app, key string, foreground bool) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if key == "" {
		return textResult("Missing required argument: key", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	return s.actionResult(app, psRequest{Tool: "press_key", App: app, Key: key, Foreground: foreground, WindowBounds: snapshot.WindowBounds})
}

func (s *service) setValue(app, elementIndex, value string) toolCallResult {
	if app == "" {
		return textResult("Missing required argument: app", true)
	}
	if elementIndex == "" {
		return textResult("Missing required argument: element_index", true)
	}
	snapshot := s.currentSnapshot(app)
	if snapshot == nil {
		return textResult("No app state is available for "+app+". Run get_app_state before action tools.", true)
	}
	record, err := lookupElement(snapshot, elementIndex)
	if err != nil {
		return textResult(err.Error(), true)
	}
	return s.actionResult(app, psRequest{Tool: "set_value", App: app, Element: record, Value: value})
}

func (s *service) actionResult(app string, request psRequest) toolCallResult {
	prepared, noAction := s.prepareAction(app, request)
	if prepared == nil {
		return noAction
	}
	snapshot, result := s.refreshSnapshot(app, *prepared)
	// A dialog that closes after its action leaves no window to observe.
	if result.IsError || snapshot == nil {
		return result
	}
	switch {
	case prepared.Tool == "click":
		snapshot.ObservationNote = clickObservationNote(prepared.observed, snapshot, prepared.Foreground)
	case prepared.Foreground:
		snapshot.ObservationNote = foregroundHandBackNote(snapshot.foregroundClick)
	}
	return snapshot.result()
}

const (
	unchangedClickNote           = "The last click did not change the window or the accessibility tree. A click that only places the text cursor or focuses a field may change nothing visible: if that was its purpose, continue with the next step and check that result; otherwise do not send the same click again."
	screenshotOnlyClickNote      = "The accessibility tree did not change, but the screenshot did; check whether it shows the intended result."
	foregroundUnchangedClickNote = "The foreground click did not change the window either; the app's menu or a keyboard shortcut may reach the same command."
)

const foregroundKeyboardDescription = "Bring this window to the front for this input and send it with real keyboard input to the window's own focus, then return the window the user had in front; the pointer does not move. It reaches documents and web page fields that window messages cannot, and modifier shortcuts. Waits for a pause in the user's typing and pointer use, and sends nothing if the user takes over. Defaults to false."

// A dialog or popup is its own window. Input routed through the window behind
// it, even at pixels where it shows in that window's screenshot, reaches the
// window behind.
func openedWindowNote(before, after *appSnapshot) string {
	if len(before.AvailableWindows) == 0 {
		return ""
	}
	known := map[int64]bool{}
	for _, window := range before.AvailableWindows {
		known[window.WindowID] = true
	}
	var opened []string
	for _, window := range after.AvailableWindows {
		if !known[window.WindowID] && window.WindowID != after.TargetWindowID {
			opened = append(opened, fmt.Sprintf("window_id=%d", window.WindowID))
		}
	}
	if len(opened) == 0 {
		return ""
	}
	return "The click opened " + strings.Join(opened, ", ") + ". A dialog or popup is its own window: call get_app_state with that window_id and act there, not through this window's screenshot."
}

func foregroundHandBackNote(handBack string) string {
	switch handBack {
	case "returned":
		return "The window was brought to the front for this input, and the previously active window is in front again."
	case "keptForUser":
		return "The user took over during this input, so the foreground was left as they set it."
	case "notReturned":
		return "The previously active window could not be brought back to the front."
	}
	return ""
}

func clickObservationNote(before, after *appSnapshot, foreground bool) string {
	if before == nil || after == nil {
		return ""
	}
	treeUnchanged := before.WindowTitle == after.WindowTitle && slices.Equal(before.TreeLines, after.TreeLines)
	imageUnchanged := before.ScreenshotPNGBase64 == after.ScreenshotPNGBase64
	var notes []string
	opened := openedWindowNote(before, after)
	if opened != "" {
		notes = append(notes, opened)
	}
	switch {
	case foreground:
		if treeUnchanged && imageUnchanged && opened == "" {
			notes = append(notes, foregroundUnchangedClickNote)
		}
		if note := foregroundHandBackNote(after.foregroundClick); note != "" {
			notes = append(notes, note)
		}
	case opened != "":
	case after.pointerDelivery == "window_message" && treeUnchanged:
		if imageUnchanged {
			notes = append(notes, unchangedClickNote)
		} else {
			notes = append(notes, screenshotOnlyClickNote)
		}
	}
	return strings.Join(notes, " ")
}

func (s *service) currentSnapshot(app string) *appSnapshot {
	last := s.snapshots[strings.ToLower(app)]
	if s.binding.ObservationID != "" {
		observed := s.observations[s.binding.ObservationID]
		if observed != nil && last != nil && observed.App.PID == last.App.PID &&
			(s.binding.WindowID == 0 || observed.TargetWindowID == s.binding.WindowID) {
			return observed
		}
	}
	if s.binding.WindowID == 0 {
		return last
	}
	if last == nil {
		return nil
	}
	return s.windows[windowKey{PID: last.App.PID, ID: s.binding.WindowID}]
}

func (s *service) refreshSnapshot(app string, request psRequest) (*appSnapshot, toolCallResult) {
	request.ctx = s.ctx
	request.DeadlineEpochMs = s.binding.DeadlineEpochMs
	request.ExpectedAppID = s.binding.ExpectedAppID
	if err := request.checkDeadline(); err != nil {
		return nil, textResult(err.Error()+" No further action was dispatched.", true)
	}
	response, err := s.runner(request)
	if err != nil {
		result := textResult(err.Error(), true)
		if request.Tool != "get_app_state" && request.Tool != "list_apps" {
			result.Content[0].Text += " An action may already have been sent. Do not replay it; run get_app_state to observe the result."
			result.Meta = map[string]any{"memmyComputerUse": map[string]any{"actionAttempted": true, "noReplay": true, "targetWindowID": request.WindowID, "pid": request.ExpectedPID}}
		}
		return nil, result
	}
	if !response.OK {
		return nil, powerShellErrorResult(response)
	}
	snapshot := response.Snapshot
	if snapshot == nil {
		return nil, textResult("Windows runtime did not return an app snapshot.", true)
	}
	if request.WindowID > 0 && snapshot.TargetWindowID != request.WindowID ||
		request.ExpectedPID > 0 && snapshot.App.PID != request.ExpectedPID {
		return nil, textResult("The Windows runtime returned a different target window or process. Its state was discarded; no action was replayed.", true)
	}
	token, err := newObservationID()
	if err != nil {
		return nil, textResult("Windows could not create an observation token. The operation was not replayed.", true)
	}
	snapshot.ObservationID = token
	snapshot.pointerDelivery, snapshot.foregroundClick = response.PointerDelivery, response.ForegroundClick
	snapshot.renderRequest = psRequest{TextLimit: request.TextLimit, MaxTreeNodes: request.MaxTreeNodes, MaxTreeDepth: request.MaxTreeDepth}
	s.rememberSnapshot(app, snapshot)
	if response.FocusChangedByApp {
		result := snapshot.result()
		result.IsError = true
		result.Content[0].Text += "\nThe app changed the foreground window and Memmy could not safely restore it. The operation is not confirmed as background-compatible. Do not replay it; observe the result before choosing another action."
		meta := result.Meta["memmyComputerUse"].(map[string]any)
		meta["focusChangedByApp"], meta["noReplay"], meta["actionDispatched"] = true, true, response.Dispatched
		return snapshot, result
	}
	return snapshot, toolCallResult{}
}

func powerShellErrorResult(response *psResponse) toolCallResult {
	const marker = "WINDOWS_FOCUS_GUARD_STOP: "
	if response.FocusGuardYield {
		result := textResult("The user is interacting with the target window. Observe its latest state before continuing; the action was not replayed.", true)
		result.Meta = map[string]any{"memmyComputerUse": map[string]any{
			"userYield":      map[string]any{"dispatched": response.Dispatched},
			"targetWindowID": response.RequestedWindowID, "pid": response.PID,
		}}
		return result
	}
	if response.TargetWindowUnavailable {
		result := textResult(response.Error, true)
		if response.Dispatched {
			// A dialog or popup closes once its command runs; that is a result.
			lines := []string{fmt.Sprintf("The action was sent, and window %d then closed, as a dialog or popup does after its command. Do not repeat the action. Call get_app_state with the window_id where its result should appear.", response.RequestedWindowID)}
			for _, window := range response.AvailableWindows {
				lines = append(lines, fmt.Sprintf("- window_id=%d %s", window.WindowID, strings.ReplaceAll(window.Title, "\n", " ")))
			}
			result = textResult(strings.Join(lines, "\n"), false)
		}
		result.Meta = map[string]any{"memmyComputerUse": map[string]any{
			"targetWindowUnavailable": true, "requestedWindowID": response.RequestedWindowID,
			"pid": response.PID, "availableWindows": response.AvailableWindows,
			"closedAfterAction": response.Dispatched,
		}}
		return result
	}
	if response.FocusGuardStop {
		return textResult(marker+response.Error, true)
	}
	if strings.HasPrefix(response.Error, marker) {
		return textResult("Windows runtime error: "+response.Error, true)
	}
	result := textResult(response.Error, true)
	if response.Dispatched {
		result.Meta = map[string]any{"memmyComputerUse": map[string]any{
			"actionDispatched": true, "noReplay": true,
			"targetWindowID": response.RequestedWindowID, "pid": response.PID,
		}}
	}
	return result
}

func (s *service) rememberSnapshot(query string, snapshot *appSnapshot) {
	if snapshot.ObservationID != "" {
		s.observations[snapshot.ObservationID] = snapshot
		for index, prior := range s.observationOrder {
			if prior == snapshot.ObservationID {
				s.observationOrder = append(s.observationOrder[:index], s.observationOrder[index+1:]...)
				break
			}
		}
		s.observationOrder = append(s.observationOrder, snapshot.ObservationID)
		bytes := 0
		for _, observed := range s.observations {
			bytes += len(observed.ScreenshotPNGBase64)
		}
		for len(s.observationOrder) > 128 || bytes > 64*1024*1024 {
			old := s.observationOrder[0]
			s.observationOrder = s.observationOrder[1:]
			if observed := s.observations[old]; observed != nil {
				bytes -= len(observed.ScreenshotPNGBase64)
			}
			delete(s.observations, old)
		}
	}
	if snapshot.TargetWindowID > 0 {
		key := windowKey{PID: snapshot.App.PID, ID: snapshot.TargetWindowID}
		s.windows[key] = snapshot
		for index, prior := range s.windowOrder {
			if prior == key {
				s.windowOrder = append(s.windowOrder[:index], s.windowOrder[index+1:]...)
				break
			}
		}
		s.windowOrder = append(s.windowOrder, key)
		for len(s.windowOrder) > 64 {
			old := s.windowOrder[0]
			s.windowOrder = s.windowOrder[1:]
			delete(s.windows, old)
			for alias, value := range s.snapshots {
				if value.App.PID == old.PID && value.TargetWindowID == old.ID {
					delete(s.snapshots, alias)
				}
			}
		}
	}
	keys := []string{query, snapshot.App.Name, snapshot.App.BundleIdentifier, strconv.Itoa(snapshot.App.PID)}
	for _, key := range keys {
		key = strings.ToLower(strings.TrimSpace(key))
		if key != "" {
			s.snapshots[key] = snapshot
		}
	}
}

func lookupElement(snapshot *appSnapshot, elementIndex string) (*elementRecord, error) {
	index, err := strconv.Atoi(elementIndex)
	if err != nil {
		return nil, fmt.Errorf("unknown element_index %q", elementIndex)
	}
	for _, record := range snapshot.Elements {
		if record.Index == index {
			copy := record
			return &copy, nil
		}
	}
	return nil, fmt.Errorf("unknown element_index %q", elementIndex)
}

// Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI
// code page, where a UTF-8 literal can swallow its closing quote.
func windowsRuntimeScriptFile() []byte {
	return append([]byte{0xef, 0xbb, 0xbf}, strings.TrimPrefix(windowsRuntimeScript, "\ufeff")...)
}

func runPowerShell(request psRequest) (*psResponse, error) {
	if runtime.GOOS != "windows" {
		return nil, errors.New("Windows Computer Use runtime requires powershell.exe on Windows")
	}
	if request.DeadlineEpochMs == 0 {
		request.DeadlineEpochMs = time.Now().Add(30 * time.Second).UnixMilli()
	}
	if err := request.checkDeadline(); err != nil {
		return nil, err
	}
	if err := ensureNativeProcessJob(); err != nil {
		return nil, err
	}

	tempDir, err := os.MkdirTemp("", "memmy-computer-use-windows-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	scriptPath := filepath.Join(tempDir, "runtime.ps1")
	operationPath := filepath.Join(tempDir, "operation.json")
	if err := os.WriteFile(scriptPath, windowsRuntimeScriptFile(), 0o600); err != nil {
		return nil, err
	}
	operationData, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(operationPath, operationData, 0o600); err != nil {
		return nil, err
	}

	parent := request.ctx
	if parent == nil {
		parent = context.Background()
	}
	deadline := time.Now().Add(30 * time.Second)
	if request.DeadlineEpochMs > 0 && time.UnixMilli(request.DeadlineEpochMs).Before(deadline) {
		deadline = time.UnixMilli(request.DeadlineEpochMs)
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, operationPath)
	configureNativeCommand(cmd)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, errors.New("Windows runtime reached its operation deadline")
	}
	if ctx.Err() != nil {
		return nil, errors.New("Windows runtime was cancelled")
	}
	if err != nil {
		text := strings.TrimSpace(string(output))
		if text == "" {
			text = err.Error()
		}
		return nil, fmt.Errorf("Windows runtime failed: %s", text)
	}

	var response psResponse
	if err := json.Unmarshal(output, &response); err != nil {
		return nil, fmt.Errorf("Windows runtime returned invalid JSON: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return &response, nil
}

func requiredString(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func optionalBool(args map[string]any, key string) (bool, error) {
	value, ok := args[key]
	if !ok || value == nil {
		return false, nil
	}
	flag, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return flag, nil
}

func optionalString(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

func requiredElementIndex(args map[string]any) string {
	return strings.TrimSpace(optionalElementIndex(args))
}

func optionalElementIndex(args map[string]any) string {
	return elementIndexString(args["element_index"])
}

func elementIndexString(value any) string {
	switch value := value.(type) {
	case string:
		return value
	case json.Number:
		if integer, err := value.Int64(); err == nil {
			return strconv.FormatInt(integer, 10)
		}
		if float, err := value.Float64(); err == nil {
			return integerElementIndexFloat(float)
		}
	case float64:
		return integerElementIndexFloat(value)
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	}
	return ""
}

func integerElementIndexFloat(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value {
		return ""
	}
	return strconv.FormatInt(int64(value), 10)
}

func requiredFloat(args map[string]any, key string) *float64 {
	return optionalFloat(args, key)
}

func optionalFloat(args map[string]any, key string) *float64 {
	switch value := args[key].(type) {
	case float64:
		return &value
	case int:
		float := float64(value)
		return &float
	case json.Number:
		float, err := value.Float64()
		if err == nil {
			return &float
		}
	}
	return nil
}

func optionalTextLimit(args map[string]any, key string) (*textLimit, error) {
	value, ok := args[key]
	if !ok {
		return nil, nil
	}
	return textLimitFromValue(value, key)
}

func textLimitFromValue(value any, key string) (*textLimit, error) {
	if stringValue, ok := value.(string); ok {
		if strings.EqualFold(stringValue, "max") {
			return &textLimit{max: true}, nil
		}
		return nil, fmt.Errorf("%s must be a positive integer or max", key)
	}
	integer, err := positiveIntFromValue(value, key)
	if err != nil {
		return nil, fmt.Errorf("%s must be a positive integer or max", key)
	}
	return &textLimit{count: *integer}, nil
}

func optionalPositiveInt(args map[string]any, key string) (*int, error) {
	value, ok := args[key]
	if !ok {
		return nil, nil
	}
	return positiveIntFromValue(value, key)
}

func positiveIntFromValue(value any, key string) (*int, error) {
	switch typed := value.(type) {
	case int:
		return positiveIntFromInt64(int64(typed), key)
	case float64:
		if !isWholeNumber(typed) {
			return nil, fmt.Errorf("%s must be a positive integer", key)
		}
		return positiveIntFromFloat64(typed, key)
	case json.Number:
		integer, err := typed.Int64()
		if err != nil {
			return nil, fmt.Errorf("%s must be a positive integer", key)
		}
		return positiveIntFromInt64(integer, key)
	default:
		return nil, fmt.Errorf("%s must be a positive integer", key)
	}
}

func positiveIntFromFloat64(value float64, key string) (*int, error) {
	if !isWholeNumber(value) || value <= 0 || value > float64(maxInt()) {
		return nil, fmt.Errorf("%s must be a positive integer", key)
	}
	integer := int(value)
	return &integer, nil
}

func positiveIntFromInt64(value int64, key string) (*int, error) {
	if value <= 0 || value > int64(maxInt()) {
		return nil, fmt.Errorf("%s must be a positive integer", key)
	}
	integer := int(value)
	return &integer, nil
}

func isWholeNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value
}

func maxInt() int {
	return int(^uint(0) >> 1)
}

func intValue(value *float64, fallback int) int {
	if value == nil {
		return fallback
	}
	return int(*value)
}

func floatValue(value *float64, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return *value
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func parseClickMethod(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return "auto", nil
	}
	for _, candidate := range clickMethodValues {
		if normalized == candidate {
			return normalized, nil
		}
	}
	return "", fmt.Errorf("Invalid click_method %q. Expected one of: %s", value, strings.Join(clickMethodValues, ", "))
}

func toolDefinitions() []toolDefinition {
	definitions := []toolDefinition{
		{
			Name:        "click",
			Description: "Click an element by index or pixel coordinates from screenshot. This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":           stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"element_index": stringProperty("Element index to click"),
				"x":             numberProperty("X coordinate in screenshot pixel coordinates"),
				"y":             numberProperty("Y coordinate in screenshot pixel coordinates"),
				"click_count":   integerProperty("Number of clicks. Defaults to 1"),
				"mouse_button":  enumStringProperty("Mouse button to click. Defaults to left.", []string{"left", "right", "middle"}),
				"click_method":  enumStringProperty("Click implementation: auto (default), accessibility, app_post, sky_click, or global. Accessibility requires element_index. On Windows, app_post sends messages to the verified target HWND without activating it or moving the physical pointer. Unsupported background input returns an error. sky_click and global are not supported.", clickMethodValues),
				"foreground":    booleanProperty("Bring this window to the front for this one click and click with real mouse input, then return the pointer and the window the user had in front. It reaches controls that ignore window messages, such as pages in Chromium-based apps. The physical pointer briefly moves to the target. Waits for a pause in the user's typing and pointer use, and sends nothing if the user takes over. Not with click_method accessibility. Defaults to false."),
			}, []string{"app"}),
		},
		{
			Name:        "drag",
			Description: "Drag from one point to another using pixel coordinates. This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":    stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"from_x": numberProperty("Start X coordinate"),
				"from_y": numberProperty("Start Y coordinate"),
				"to_x":   numberProperty("End X coordinate"),
				"to_y":   numberProperty("End Y coordinate"),
			}, []string{"app", "from_x", "from_y", "to_x", "to_y"}),
		},
		{
			Name:        "get_app_state",
			Description: "Get the state of an app's key window and return a screenshot and accessibility tree. An installed app that is not running, or has no window open, is opened from its Start menu entry first. This must be called once per assistant turn before interacting with the app. This tool is part of plugin `Computer Use`.",
			Annotations: readOnlyAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":            stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"text_limit":     textLimitProperty("Maximum text characters to return. Use \"max\" for full text. Defaults to 500."),
				"max_tree_nodes": positiveIntegerProperty("Maximum accessibility tree nodes to render. Defaults to 1200."),
				"max_tree_depth": positiveIntegerProperty("Maximum accessibility tree depth to render. Defaults to 64."),
			}, []string{"app"}),
		},
		{
			Name:        "list_apps",
			Description: "List currently running apps with top-level windows in this Windows desktop session. Returns installed app names, stable app identifiers, process names, and process IDs; window titles are not app selectors; it does not include recent or closed apps. This tool is part of plugin `Computer Use`.",
			Annotations: readOnlyAnnotations(),
			InputSchema: objectSchema(map[string]any{}, nil),
		},
		{
			Name:        "perform_secondary_action",
			Description: "Invoke a secondary accessibility action exposed by an element. This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":           stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"element_index": stringProperty("Element identifier"),
				"action":        stringProperty("Secondary accessibility action name"),
			}, []string{"app", "element_index", "action"}),
		},
		{
			Name:        "press_key",
			Description: "Send a key or key combination to the target Windows app. In the background it is sent as window messages, which carry no modifier state. Supported modifiers are ctrl, shift, alt, and win (also super or cmd). Examples: \"a\", \"Return\", \"Tab\", \"ctrl+c\", \"Up\", \"KP_0\". This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":        stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"key":        stringProperty("Key or key-combination to press"),
				"foreground": booleanProperty(foregroundKeyboardDescription),
			}, []string{"app", "key"}),
		},
		{
			Name:        "scroll",
			Description: "Scroll an element or screenshot coordinate in a direction by a number of pages. Coordinate scrolling posts directly to the target app and does not move the system pointer. This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":           stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"direction":     stringProperty("Scroll direction: up, down, left, or right"),
				"element_index": stringProperty("Element identifier"),
				"x":             numberProperty("X coordinate in screenshot pixel coordinates, used with y instead of element_index"),
				"y":             numberProperty("Y coordinate in screenshot pixel coordinates, used with x instead of element_index"),
				"pages":         numberProperty("Number of pages to scroll. Fractional values are supported. Defaults to 1"),
			}, []string{"app", "direction"}),
		},
		{
			Name:        "set_value",
			Description: "Set the value of a settable accessibility element. This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":           stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"element_index": stringProperty("Element identifier"),
				"value":         stringProperty("Value to assign"),
			}, []string{"app", "element_index", "value"}),
		},
		{
			Name:        "type_text",
			Description: "Insert literal text into the target Windows app. In the background it reaches only native Edit/RichEdit controls; documents such as Word's, and web page fields, take it with foreground=true. This tool is part of plugin `Computer Use`.",
			Annotations: defaultAnnotations(),
			InputSchema: objectSchema(map[string]any{
				"app":        stringProperty("Exact app identifier, installed app name, process name, or process ID returned by list_apps"),
				"text":       stringProperty("Literal text to type"),
				"foreground": booleanProperty(foregroundKeyboardDescription),
			}, []string{"app", "text"}),
		},
	}
	for index := range definitions {
		tool := &definitions[index]
		if tool.Name == "list_apps" {
			continue
		}
		properties := tool.InputSchema["properties"].(map[string]any)
		properties["window_id"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 9007199254740991,
			"description": "Exact Windows HWND from get_app_state. Observe a new document explicitly before acting on it."}
		if tool.Name != "get_app_state" {
			properties["observation_id"] = stringProperty("Token of the state used to choose this action. Changed state returns a fresh observation without dispatch.")
		}
	}
	return definitions
}
func objectSchema(properties map[string]any, required []string) map[string]any {
	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func defaultAnnotations() map[string]any {
	return map[string]any{"destructiveHint": false, "openWorldHint": false}
}

func readOnlyAnnotations() map[string]any {
	return map[string]any{"destructiveHint": false, "idempotentHint": true, "openWorldHint": false, "readOnlyHint": true}
}

func stringProperty(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func enumStringProperty(description string, values []string) map[string]any {
	property := stringProperty(description)
	property["enum"] = values
	return property
}

func booleanProperty(description string) map[string]any {
	return map[string]any{"type": "boolean", "description": description}
}

func numberProperty(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}

func integerProperty(description string) map[string]any {
	return map[string]any{"type": "integer", "description": description}
}

func positiveIntegerProperty(description string) map[string]any {
	return map[string]any{"type": "integer", "minimum": 1, "description": description}
}

func textLimitProperty(description string) map[string]any {
	return map[string]any{
		"anyOf": []any{
			map[string]any{"type": "integer", "minimum": 1},
			map[string]any{"type": "string", "enum": []string{"max"}},
		},
		"description": description,
	}
}

func main() {
	if err := runCLI(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runCLI(args []string, stdout io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stdout, helpText(""))
		return nil
	}

	switch args[0] {
	case "-h", "--help", "help":
		topic := ""
		if len(args) > 1 {
			topic = args[1]
		}
		fmt.Fprint(stdout, helpText(topic))
		return nil
	case "-v", "--version", "version":
		fmt.Fprintln(stdout, version)
		return nil
	case "mcp":
		return runMCP(os.Stdin, stdout)
	case "doctor":
		fmt.Fprintln(stdout, "Windows runtime: UI Automation and Win32 window-message bridge are available when this process runs in the signed-in desktop session.")
		return nil
	case "focus-snapshot", "reveal-window":
		request := psRequest{Tool: "focus_snapshot", DeadlineEpochMs: time.Now().Add(3 * time.Second).UnixMilli()}
		if args[0] == "focus-snapshot" && len(args) != 1 {
			return errors.New("focus-snapshot accepts no arguments")
		}
		if args[0] == "reveal-window" {
			var err error
			request, err = parseRevealWindowArgs(args[1:])
			if err != nil {
				return err
			}
			request.DeadlineEpochMs = time.Now().Add(5 * time.Second).UnixMilli()
		}
		response, err := runPowerShell(request)
		if err != nil {
			return err
		}
		if !response.OK {
			return errors.New(response.Error)
		}
		if request.Tool == "focus_snapshot" {
			if response.FocusState == nil {
				return errors.New("Windows focus state is unavailable")
			}
			return json.NewEncoder(stdout).Encode(response.FocusState)
		}
		return json.NewEncoder(stdout).Encode(map[string]bool{"success": response.Success})
	case "resolve-app":
		return resolveAppCommand(args[1:], runPowerShell, stdout)
	case "list-apps":
		result := newService().callTool("list_apps", map[string]any{})
		if result.IsError {
			return errors.New(result.Content[0].Text)
		}
		fmt.Fprintln(stdout, result.Content[0].Text)
		return nil
	case "snapshot":
		app, textLimit, maxTreeNodes, maxTreeDepth, err := parseSnapshotArgs(args[1:])
		if err != nil {
			return err
		}
		toolArgs := map[string]any{
			"app": app,
		}
		if textLimit != nil {
			toolArgs["text_limit"] = textLimit.runtimeValue()
		}
		if maxTreeNodes != nil {
			toolArgs["max_tree_nodes"] = *maxTreeNodes
		}
		if maxTreeDepth != nil {
			toolArgs["max_tree_depth"] = *maxTreeDepth
		}
		result := newService().callTool("get_app_state", toolArgs)
		if result.IsError {
			return errors.New(result.Content[0].Text)
		}
		fmt.Fprintln(stdout, result.Content[0].Text)
		return nil
	case "call":
		output, hasError, err := runCallCommand(args[1:], newService())
		if err != nil {
			return err
		}
		encoded, err := json.MarshalIndent(output, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(stdout, string(encoded))
		if hasError {
			return errors.New("tool call returned isError=true")
		}
		return nil
	default:
		return fmt.Errorf("unknown command: %s\n\n%s", args[0], helpText(""))
	}
}

// Read-only: the host approves the resolved app before get_app_state opens it.
func resolveAppCommand(args []string, runner func(psRequest) (*psResponse, error), stdout io.Writer) error {
	if len(args) != 2 || args[0] != "--query" || strings.TrimSpace(args[1]) == "" {
		return errors.New("resolve-app requires --query <app-name-or-id>")
	}
	response, err := runner(psRequest{Tool: "resolve_app", App: args[1], DeadlineEpochMs: time.Now().Add(20 * time.Second).UnixMilli()})
	if err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Error)
	}
	if response.Resolution == nil {
		return errors.New("Windows runtime did not return an app resolution")
	}
	resolution := *response.Resolution
	resolution.Platform = "win32"
	return json.NewEncoder(stdout).Encode(resolution)
}

func parseSnapshotArgs(args []string) (string, *textLimit, *int, *int, error) {
	var app string
	var textLimit *textLimit
	var maxTreeNodes *int
	var maxTreeDepth *int
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch arg {
		case "--text-limit":
			index++
			if index >= len(args) {
				return "", nil, nil, nil, errors.New("--text-limit requires a positive integer or max value")
			}
			value, err := parseTextLimitOption(args[index], "--text-limit")
			if err != nil {
				return "", nil, nil, nil, err
			}
			textLimit = value
		case "--max-tree-nodes":
			index++
			if index >= len(args) {
				return "", nil, nil, nil, errors.New("--max-tree-nodes requires a positive integer value")
			}
			value, err := parsePositiveIntegerOption(args[index], "--max-tree-nodes")
			if err != nil {
				return "", nil, nil, nil, err
			}
			maxTreeNodes = &value
		case "--max-tree-depth":
			index++
			if index >= len(args) {
				return "", nil, nil, nil, errors.New("--max-tree-depth requires a positive integer value")
			}
			value, err := parsePositiveIntegerOption(args[index], "--max-tree-depth")
			if err != nil {
				return "", nil, nil, nil, err
			}
			maxTreeDepth = &value
		default:
			if strings.HasPrefix(arg, "-") {
				return "", nil, nil, nil, fmt.Errorf("unknown snapshot option: %s", arg)
			}
			if app != "" {
				return "", nil, nil, nil, errors.New("snapshot accepts exactly one installed app name, app identifier, process name, or pid")
			}
			app = arg
		}
	}
	if app == "" {
		return "", nil, nil, nil, errors.New("snapshot requires an installed app name, app identifier, process name, or pid")
	}
	return app, textLimit, maxTreeNodes, maxTreeDepth, nil
}

func parseTextLimitOption(value, option string) (*textLimit, error) {
	if strings.EqualFold(value, "max") {
		return &textLimit{max: true}, nil
	}
	integer, err := strconv.Atoi(value)
	if err != nil || integer <= 0 {
		return nil, fmt.Errorf("%s must be a positive integer or max", option)
	}
	return &textLimit{count: integer}, nil
}

func parsePositiveIntegerOption(value, option string) (int, error) {
	integer, err := strconv.Atoi(value)
	if err != nil || integer <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", option)
	}
	return integer, nil
}

func runCallCommand(args []string, svc *service) (any, bool, error) {
	if len(args) == 0 {
		return nil, false, errors.New("call requires a tool name or --calls/--calls-file")
	}

	var toolName, argsJSON, argsFile, callsJSON, callsFile string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch arg {
		case "--args":
			index++
			if index >= len(args) {
				return nil, false, errors.New("--args requires a value")
			}
			argsJSON = args[index]
		case "--args-file":
			index++
			if index >= len(args) {
				return nil, false, errors.New("--args-file requires a value")
			}
			argsFile = args[index]
		case "--calls":
			index++
			if index >= len(args) {
				return nil, false, errors.New("--calls requires a value")
			}
			callsJSON = args[index]
		case "--calls-file":
			index++
			if index >= len(args) {
				return nil, false, errors.New("--calls-file requires a value")
			}
			callsFile = args[index]
		default:
			if strings.HasPrefix(arg, "-") {
				return nil, false, fmt.Errorf("unknown call option: %s", arg)
			}
			if toolName != "" {
				return nil, false, errors.New("call accepts at most one tool name")
			}
			toolName = arg
		}
	}

	if callsJSON != "" || callsFile != "" {
		if toolName != "" || argsJSON != "" || argsFile != "" {
			return nil, false, errors.New("call sequence does not accept a tool name, --args, or --args-file")
		}
		calls, err := readCallSequence(callsJSON, callsFile)
		if err != nil {
			return nil, false, err
		}
		var outputs []map[string]any
		hasError := false
		for _, call := range calls {
			result := svc.callTool(call.Tool, call.Args)
			outputs = append(outputs, map[string]any{"tool": call.Tool, "result": result})
			if result.IsError {
				hasError = true
				break
			}
		}
		return outputs, hasError, nil
	}

	if toolName == "" {
		return nil, false, errors.New("call requires a tool name or --calls/--calls-file")
	}
	arguments, err := readArguments(argsJSON, argsFile)
	if err != nil {
		return nil, false, err
	}
	result := svc.callTool(toolName, arguments)
	return result, result.IsError, nil
}

type callSpec struct {
	Tool string
	Args map[string]any
}

func readArguments(inline, file string) (map[string]any, error) {
	if inline != "" && file != "" {
		return nil, errors.New("Use either inline JSON or a JSON file, not both")
	}
	if inline == "" && file == "" {
		return map[string]any{}, nil
	}
	source, err := readJSONSource(inline, file)
	if err != nil {
		return nil, err
	}
	var args map[string]any
	decoder := json.NewDecoder(strings.NewReader(source))
	decoder.UseNumber()
	if err := decoder.Decode(&args); err != nil {
		return nil, fmt.Errorf("Invalid JSON input: %w", err)
	}
	if args == nil {
		return nil, errors.New("--args must be a JSON object")
	}
	return args, nil
}

func readCallSequence(inline, file string) ([]callSpec, error) {
	if inline != "" && file != "" {
		return nil, errors.New("Use either --calls or --calls-file, not both")
	}
	source, err := readJSONSource(inline, file)
	if err != nil {
		return nil, err
	}
	var raw []map[string]any
	decoder := json.NewDecoder(strings.NewReader(source))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("Invalid JSON input: %w", err)
	}
	calls := make([]callSpec, 0, len(raw))
	for index, item := range raw {
		name, _ := item["tool"].(string)
		if name == "" {
			name, _ = item["name"].(string)
		}
		if name == "" {
			return nil, fmt.Errorf("call sequence item #%d requires a non-empty tool", index+1)
		}
		args, _ := item["args"].(map[string]any)
		if args == nil {
			args, _ = item["arguments"].(map[string]any)
		}
		if args == nil {
			args = map[string]any{}
		}
		calls = append(calls, callSpec{Tool: name, Args: args})
	}
	return calls, nil
}

func readJSONSource(inline, file string) (string, error) {
	if inline != "" {
		return inline, nil
	}
	if file == "" {
		return "", errors.New("JSON input is required")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func runMCP(stdin io.Reader, stdout io.Writer) error {
	return runMCPService(stdin, stdout, newService())
}

// Read cancellation and EOF while the serial service is observing or acting.
// Closing MCP stdin cancels the active PowerShell context before any next action phase.
func runMCPService(stdin io.Reader, stdout io.Writer, svc *service) error {
	lifetime, stop := context.WithCancel(context.Background())
	defer stop()
	type incoming struct {
		request map[string]any
		ctx     context.Context
		cancel  context.CancelFunc
		key     string
	}
	requests := make(chan incoming, 64)
	var mutex sync.Mutex
	pending := map[string]context.CancelFunc{}
	decoder := json.NewDecoder(stdin)
	encoder := json.NewEncoder(stdout)
	go func() {
		defer close(requests)
		defer stop()
		for {
			var request map[string]any
			if err := decoder.Decode(&request); err != nil {
				if errors.Is(err, io.EOF) {
					return
				}
				select {
				case requests <- incoming{request: map[string]any{"_parseError": true}}:
				case <-lifetime.Done():
					return
				}
				// Stop on a malformed stream; retrying a decoder at the same byte can loop forever.
				return
			}
			if request["method"] == "notifications/cancelled" {
				params, _ := request["params"].(map[string]any)
				id, _ := json.Marshal(params["requestId"])
				mutex.Lock()
				cancel := pending[string(id)]
				mutex.Unlock()
				if cancel != nil {
					cancel()
				}
				continue
			}
			ctx, cancel := context.WithCancel(lifetime)
			id, _ := json.Marshal(request["id"])
			key := string(id)
			if request["id"] != nil {
				mutex.Lock()
				pending[key] = cancel
				mutex.Unlock()
			}
			select {
			case requests <- incoming{request: request, ctx: ctx, cancel: cancel, key: key}:
			case <-lifetime.Done():
				cancel()
				return
			}
		}
	}()
	for item := range requests {
		if item.request["_parseError"] == true {
			if err := encoder.Encode(jsonRPCError(nil, -32700, "Invalid JSON-RPC payload")); err != nil {
				return err
			}
			continue
		}
		svc.ctx = item.ctx
		response := handleMCPRequest(item.request, svc)
		item.cancel()
		mutex.Lock()
		delete(pending, item.key)
		mutex.Unlock()
		if response != nil {
			if err := encoder.Encode(response); err != nil {
				return err
			}
		}
	}
	return nil
}

func handleMCPRequest(request map[string]any, svc *service) map[string]any {
	id := request["id"]
	method, _ := request["method"].(string)
	params, _ := request["params"].(map[string]any)
	switch method {
	case "initialize":
		return jsonRPCResult(id, map[string]any{
			"protocolVersion": "2025-03-26",
			"serverInfo": map[string]any{
				"name":    "memmy-computer-use",
				"version": version,
			},
			"capabilities": map[string]any{"tools": map[string]any{"listChanged": false}},
			"instructions": serverInstructions,
		})
	case "notifications/initialized", "notifications/turn-ended":
		return nil
	case "ping":
		return jsonRPCResult(id, map[string]any{})
	case "tools/list":
		return jsonRPCResult(id, map[string]any{"tools": toolDefinitions()})
	case "tools/call":
		name, _ := params["name"].(string)
		arguments, _ := params["arguments"].(map[string]any)
		if arguments == nil {
			arguments = map[string]any{}
		}
		return jsonRPCResult(id, svc.callTool(name, arguments))
	default:
		if method == "" {
			return nil
		}
		return jsonRPCError(id, -32601, "Method not found: "+method)
	}
}

func jsonRPCResult(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func jsonRPCError(id any, code int, message string) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	}
}

func helpText(command string) string {
	switch command {
	case "mcp":
		return "Usage:\n  memmy-computer-use.exe mcp\n\nStart the stdio MCP server.\n"
	case "call":
		return "Usage:\n  memmy-computer-use.exe call <tool> [--args '<json-object>']\n  memmy-computer-use.exe call --calls '<json-array>'\n\nThe JSON array form keeps all calls in one process so element_index state can be reused.\n"
	case "snapshot":
		return "Usage:\n  memmy-computer-use.exe snapshot [--text-limit <positive-int|max>] [--max-tree-nodes <positive-int>] [--max-tree-depth <positive-int>] <app>\n\nPrint the current Windows UI Automation snapshot for the target app.\n"
	default:
		return `Memmy Computer Use for Windows

Usage:
  memmy-computer-use.exe [command] [options]

Commands:
  mcp                  Start the stdio MCP server.
  doctor               Print Windows runtime notes.
  list-apps            Print running apps with top-level windows.
  resolve-app --query  Print the app identity get_app_state would open, as JSON.
  snapshot <app>       Print the current UI Automation snapshot for an app.
  call <tool>           Call one tool, or run a JSON array of tool calls.
  help [command]       Show general or command-specific help.
  version              Print the CLI version.

Notes:
  The Windows runtime uses UI Automation and exact-window background messages.
  Unsupported background input returns an error. Run it in the signed-in desktop session.
`
	}
}
