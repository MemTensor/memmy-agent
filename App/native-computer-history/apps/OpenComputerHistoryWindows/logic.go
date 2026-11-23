package main

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

const runtimeID = "MemmyWindowsHistoryRuntimeV1"
const maxProtocolBytes = 512 * 1024
const maxTextCharacters = 120000
const fullTreeInterval = time.Second
const idleInterval = 4 * time.Second
const inputSettle = time.Second
const workerDeadline = 4 * time.Second

var version = "dev"
var appIDPattern = regexp.MustCompile(`^win32\.[a-z0-9._-]{1,128}$`)
var windowIDPattern = regexp.MustCompile(`^[0-9]{1,20}$`)

type originContext struct {
	Window  string
	PID     uint32
	URL     string
	Focus   string
	Scope   uint64
	Content uint64
	At      time.Time
}

var verifiedOrigin atomic.Pointer[originContext]

func bindOrigin(a *action) {
	origin := verifiedOrigin.Load()
	if origin != nil && origin.Window == a.Window && origin.PID == a.PID && time.Since(origin.At) <= 5*time.Second {
		a.OriginVerified = true
		a.ExpectedURL = origin.URL
		a.ExpectedFocus = origin.Focus
		a.ExpectedScope = origin.Scope
		a.ExpectedContent = origin.Content
	}
}

func rememberOrigin(event map[string]any) {
	window, _ := event["window"].(map[string]any)
	app, _ := event["app"].(map[string]any)
	id, _ := window["windowId"].(string)
	pid, _ := app["pid"].(float64)
	url, _ := window["url"].(string)
	scope, _ := event["nativeScopeGeneration"].(float64)
	content, _ := event["nativeContentGeneration"].(float64)
	ax, _ := event["ax"].(map[string]any)
	focus, _ := ax["focused"].(map[string]any)
	focusID, _ := focus["runtimeId"].(string)
	verifiedOrigin.Store(&originContext{Window: id, PID: uint32(pid), URL: url, Focus: focusID, Scope: uint64(scope), Content: uint64(content), At: time.Now()})
	delete(event, "nativeScopeGeneration")
	delete(event, "nativeContentGeneration")
}

// No typed characters, scan codes or raw printable virtual-key codes cross
// this boundary. A burst is a count plus a small non-text action category.
type action struct {
	Kind            string   `json:"kind"`
	Window          string   `json:"window"`
	PID             uint32   `json:"pid"`
	Timestamp       string   `json:"timestamp"`
	X               int32    `json:"x,omitempty"`
	Y               int32    `json:"y,omitempty"`
	Button          string   `json:"button,omitempty"`
	Delta           int32    `json:"delta,omitempty"`
	Key             string   `json:"key,omitempty"`
	KeyCode         uint32   `json:"keyCode,omitempty"`
	Count           int      `json:"count,omitempty"`
	Modifiers       []string `json:"modifiers,omitempty"`
	OriginVerified  bool     `json:"originVerified"`
	ExpectedURL     string   `json:"expectedURL,omitempty"`
	ExpectedFocus   string   `json:"expectedFocus,omitempty"`
	ExpectedScope   uint64   `json:"expectedScope"`
	ExpectedContent uint64   `json:"expectedContent"`
	ScrollAxis      string   `json:"scrollAxis,omitempty"`
}

func safeKey(vk uint32) (string, uint32) {
	switch vk {
	case 13:
		return "Enter", 13
	case 8:
		return "Backspace", 8
	case 9:
		return "Tab", 9
	case 27:
		return "Escape", 27
	case 33, 34, 35, 36, 37, 38, 39, 40:
		return "[navigation]", 0
	case 16, 17, 18, 20, 91, 92, 144, 145:
		return "", 0
	default:
		return "[typing]", 0
	}
}

type scheduler struct {
	lastFull time.Time
	lastPoll time.Time
	typing   *action
	typingAt time.Time
	pending  []action
	dropped  int
}

func (s *scheduler) add(a action, at time.Time) {
	if a.Kind == "focus.changed" {
		if s.typing != nil {
			s.typing = nil
			s.dropped++
		}
		a.Kind = "accessibility.changed"
	}
	if a.Kind == "keyboard.keydown" && a.Key == "[typing]" {
		if s.typing != nil && (s.typing.Window != a.Window || s.typing.PID != a.PID || s.typing.ExpectedURL != a.ExpectedURL || s.typing.ExpectedFocus != a.ExpectedFocus || s.typing.ExpectedScope != a.ExpectedScope) {
			// A burst whose original window lost focus is not enriched in the
			// new window, even if the applications have the same process.
			s.typing = nil
		}
		if s.typing == nil {
			a.Count = 0
			s.typing = &a
		}
		s.typing.Count++
		s.typing.Timestamp = a.Timestamp
		if s.typing.Count > 1024 {
			s.typing.Count = 1024
		}
		s.typingAt = at
		return
	}
	if a.Kind == "accessibility.changed" || a.Kind == "window.changed" || a.Kind == "selection.changed" {
		for i := range s.pending {
			if s.pending[i].Kind == a.Kind && s.pending[i].Window == a.Window && s.pending[i].PID == a.PID {
				s.pending[i] = a
				return
			}
		}
	}
	if a.Kind == "mouse.scroll" && len(s.pending) > 0 {
		last := &s.pending[len(s.pending)-1]
		if last.Kind == a.Kind && last.Window == a.Window && last.PID == a.PID && last.ScrollAxis == a.ScrollAxis && last.ExpectedURL == a.ExpectedURL && last.ExpectedScope == a.ExpectedScope {
			last.Delta += a.Delta
			last.Timestamp = a.Timestamp
			return
		}
	}
	if len(s.pending) >= 16 {
		s.pending = s.pending[1:]
		s.dropped++
	}
	s.pending = append(s.pending, a)
}

func (s *scheduler) next(now time.Time) (action, bool, bool) {
	if s.typing != nil && now.Sub(s.typingAt) >= inputSettle {
		a := *s.typing
		s.typing = nil
		if len(s.pending) >= 16 {
			s.pending = s.pending[1:]
			s.dropped++
		}
		s.pending = append(s.pending, a)
	}
	var a action
	if len(s.pending) > 0 {
		a = s.pending[0]
		s.pending = s.pending[1:]
	} else {
		if now.Sub(s.lastPoll) < time.Second {
			return a, false, false
		}
		a.Kind = "probe"
	}
	full := now.Sub(s.lastFull) >= fullTreeInterval &&
		(a.Kind != "probe" || now.Sub(s.lastFull) >= idleInterval)
	if full {
		s.lastFull = now
	}
	s.lastPoll = now
	return a, full, true
}

type workerRequest struct {
	ID          uint64 `json:"id"`
	Action      action `json:"action"`
	Full        bool   `json:"full"`
	ConsentPath string `json:"consentPath,omitempty"`
}
type workerResult struct {
	ID                uint64         `json:"id"`
	OK                bool           `json:"ok"`
	Skipped           bool           `json:"skipped"`
	Reason            string         `json:"reason,omitempty"`
	Truncated         bool           `json:"truncated,omitempty"`
	ReadFailures      int            `json:"readFailures"`
	SnapshotAttempted bool           `json:"snapshotAttempted,omitempty"`
	SnapshotDeferred  bool           `json:"snapshotDeferred,omitempty"`
	Event             map[string]any `json:"event,omitempty"`
}

// A functioning action/heartbeat path is not proof that full UIA reads work.
// Emit failures independently; only the Node recorder can acknowledge recovery
// after authorizing and persisting a complete readable snapshot.
func snapshotFailed(fullRequested bool, result workerResult, requestErr error) bool {
	if requestErr != nil || !result.OK {
		return fullRequested || result.SnapshotAttempted
	}
	// Foreground changes, consent and secure inputs intentionally skip reads.
	if result.Skipped {
		return false
	}
	ax, _ := result.Event["ax"].(map[string]any)
	if ax["mode"] != "fullTree" {
		return (fullRequested || result.SnapshotAttempted) && !result.SnapshotDeferred
	}
	text, readable := ax["text"].(string)
	return !readable || strings.TrimSpace(text) == "" || result.ReadFailures > 0
}

func attachSnapshotQuality(result *workerResult) {
	if ax, ok := result.Event["ax"].(map[string]any); ok && ax["mode"] == "fullTree" {
		ax["truncated"] = result.Truncated
		ax["readFailures"] = result.ReadFailures
	}
}

// Only the Node recorder knows which snapshots passed current policy and were
// persisted. Always forward full reads so it can rebuild an authorized baseline
// after exclusions, failures or restart, even when native text is unchanged.
func shouldForwardSample(event map[string]any, lastWindow string) bool {
	window, _ := event["window"].(map[string]any)
	windowID, _ := window["windowId"].(string)
	if event["kind"] != "sampling.changed" || windowID != lastWindow {
		return true
	}
	ax, _ := event["ax"].(map[string]any)
	_, hasText := ax["text"].(string)
	return ax["mode"] == "fullTree" && hasText
}

// Preserve the fact that input was observed when its target cannot be safely
// recovered. Never copy coordinates, keys, labels, app identity or URLs into a
// scope-less coverage record. Deliberate password/consent skips stay excluded.
func actionCaptureGap(a action, result workerResult, requestErr error) map[string]any {
	switch a.Kind {
	case "mouse.click", "mouse.context_menu", "mouse.scroll", "keyboard.keydown":
	default:
		return nil
	}
	at, err := time.Parse(time.RFC3339Nano, a.Timestamp)
	if err != nil || at.IsZero() {
		return nil
	}
	reason := ""
	if requestErr != nil || !result.OK {
		reason = "worker_failed"
	} else if result.Skipped {
		switch result.Reason {
		case "action_origin_unknown", "action_origin_expired", "action_origin_changed", "foreground_changed", "navigation_changed", "focus_changed":
			reason = result.Reason
		}
	}
	if reason == "" {
		return nil
	}
	count := a.Count
	if count < 1 || count > 10000 {
		count = 1
	}
	gap := map[string]any{"type": "recorder.capture_gap", "actionTimestamp": at.UTC().Format(time.RFC3339Nano),
		"actionKind": a.Kind, "count": count, "reason": reason}
	if (a.Kind == "mouse.click" || a.Kind == "mouse.context_menu") &&
		(a.Button == "left" || a.Button == "right" || a.Button == "middle") {
		gap["button"] = a.Button
	}
	return gap
}

func parseResult(raw []byte, expected uint64) (workerResult, error) {
	var r workerResult
	if len(raw) == 0 || len(raw) > maxProtocolBytes {
		return r, fmt.Errorf("worker protocol size")
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, fmt.Errorf("worker protocol JSON")
	}
	if r.ID != expected || r.ReadFailures < 0 || r.ReadFailures > 10000 {
		return r, fmt.Errorf("worker protocol identity")
	}
	if !r.OK || r.Skipped {
		r.Event = nil
		return r, nil
	}
	if r.Event == nil {
		return r, fmt.Errorf("worker protocol missing event")
	}
	app, aok := r.Event["app"].(map[string]any)
	window, wok := r.Event["window"].(map[string]any)
	if !aok || !wok {
		return r, fmt.Errorf("worker protocol envelope")
	}
	if id, ok := app["bundleIdentifier"].(string); !ok || !appIDPattern.MatchString(id) {
		return r, fmt.Errorf("worker protocol app")
	}
	windowID, idOK := window["windowId"].(string)
	appPID, pidOK := app["pid"].(float64)
	windowPID, windowPIDOK := window["processId"].(float64)
	browser, browserOK := window["browser"].(bool)
	if !idOK || !windowIDPattern.MatchString(windowID) || !pidOK || appPID <= 0 || appPID > math.MaxInt32 || math.Trunc(appPID) != appPID || !windowPIDOK || windowPID != appPID || !browserOK {
		return r, fmt.Errorf("worker protocol foreground identity")
	}
	if at, ok := r.Event["timestamp"].(string); !ok {
		return r, fmt.Errorf("worker protocol timestamp")
	} else if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
		return r, fmt.Errorf("worker protocol timestamp")
	}
	kind, _ := r.Event["kind"].(string)
	switch kind {
	case "window.changed", "accessibility.changed", "sampling.changed", "mouse.click", "mouse.context_menu", "mouse.scroll", "keyboard.keydown", "selection.changed":
	default:
		return r, fmt.Errorf("worker protocol action")
	}
	if app["secureInput"] == true {
		return r, fmt.Errorf("worker secure input")
	}
	if browser {
		context, ok := window["browserContext"].(map[string]any)
		if !ok {
			return r, fmt.Errorf("worker browser context")
		}
		if context["windowId"] != windowID || context["processId"] != appPID {
			return r, fmt.Errorf("worker browser foreground identity")
		}
		// A page address is optional (the omnibox may be focused or the page
		// loading), but one that is present must be the committed web URI.
		if url, ok := context["url"].(string); !ok {
			return r, fmt.Errorf("worker browser URL")
		} else if url != "" {
			if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
				return r, fmt.Errorf("worker browser URL")
			}
			if context["documentUrl"] != url {
				return r, fmt.Errorf("worker browser committed URI")
			}
		}
	}
	if r.SnapshotDeferred && r.SnapshotAttempted {
		return r, fmt.Errorf("worker deferred snapshot contradiction")
	}
	if ax, ok := r.Event["ax"].(map[string]any); ok {
		if r.SnapshotDeferred && ax["mode"] == "fullTree" {
			return r, fmt.Errorf("worker deferred snapshot contradiction")
		}
		if observedAt, present := ax["observedAt"]; present {
			at, valid := observedAt.(string)
			if ax["mode"] != "fullTree" || !valid {
				return r, fmt.Errorf("worker snapshot observation shape")
			}
			if parsed, err := time.Parse(time.RFC3339Nano, at); err != nil || parsed.IsZero() {
				return r, fmt.Errorf("worker snapshot observation timestamp")
			}
		}
		content, hasText := ax["text"]
		if ax["mode"] != nil || hasText {
			text, valid := content.(string)
			if ax["mode"] != "fullTree" || !valid {
				return r, fmt.Errorf("worker snapshot shape")
			}
			if len([]rune(text)) > maxTextCharacters {
				return r, fmt.Errorf("worker text budget")
			}
		}
	}
	return r, nil
}

func pureSelfTest() error {
	for vk := uint32(0); vk < 256; vk++ {
		key, code := safeKey(vk)
		if key == "[typing]" && code != 0 {
			return fmt.Errorf("typing code escaped")
		}
	}
	s := scheduler{}
	start := time.Now()
	for i := 0; i < 100; i++ {
		s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "1", PID: 1}, start)
	}
	if s.typing == nil || s.typing.Count != 100 || len(s.pending) != 0 {
		return fmt.Errorf("typing not coalesced")
	}
	return nil
}
