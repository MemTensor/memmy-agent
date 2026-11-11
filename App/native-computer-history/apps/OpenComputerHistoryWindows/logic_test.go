package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPrintableKeysNeverEscapeAsTextOrVirtualCodes(t *testing.T) {
	for vk := uint32(0); vk < 256; vk++ {
		name, code := safeKey(vk)
		if name == "[typing]" && code != 0 {
			t.Fatalf("raw key escaped: %d", vk)
		}
		if name != "" && !strings.HasPrefix(name, "[") && name != "Enter" && name != "Backspace" && name != "Tab" && name != "Escape" {
			t.Fatalf("unexpected key: %s", name)
		}
	}
	for vk := uint32(65); vk <= 90; vk++ {
		key, code := safeKey(vk)
		if key != "[typing]" || code != 0 {
			t.Fatalf("letter revealed: %d", vk)
		}
	}
}

func TestTypingSettlesOnceWithoutPerKeyTreeReads(t *testing.T) {
	s := scheduler{}
	now := time.Unix(1700000000, 0)
	for i := 0; i < 30; i++ {
		s.add(action{Kind: "keyboard.keydown", Window: "10", PID: 20, Key: "[typing]"}, now.Add(time.Duration(i)*20*time.Millisecond))
	}
	s.lastPoll = now.Add(600 * time.Millisecond)
	if _, _, ok := s.next(now.Add(900 * time.Millisecond)); ok {
		t.Fatal("typing did not debounce")
	}
	a, full, ok := s.next(now.Add(2 * time.Second))
	if !ok || !full || a.Kind != "keyboard.keydown" || a.Count != 30 || s.typing != nil {
		t.Fatalf("invalid burst: %+v", a)
	}
	if len(s.pending) != 0 {
		t.Fatal("burst emitted twice")
	}
}

func TestDifferentWindowsCannotMergeTypedBursts(t *testing.T) {
	s := scheduler{}
	now := time.Now()
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "1", PID: 1}, now)
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "2", PID: 1}, now)
	a, _, _ := s.next(now.Add(2 * time.Second))
	if a.Window != "2" || a.Count != 1 {
		t.Fatalf("cross-window attribution: %+v", a)
	}
}

func TestFullTreesThrottledAndIdleReadsFourSeconds(t *testing.T) {
	s := scheduler{}
	now := time.Unix(1700000000, 0)
	s.add(action{Kind: "mouse.click"}, now)
	_, full, _ := s.next(now)
	if !full {
		t.Fatal("initial tree absent")
	}
	s.add(action{Kind: "mouse.click"}, now.Add(100*time.Millisecond))
	_, full, _ = s.next(now.Add(100 * time.Millisecond))
	if full {
		t.Fatal("full tree read more than once per second")
	}
	_, full, _ = s.next(now.Add(2 * time.Second))
	if full {
		t.Fatal("idle tree read too early")
	}
	_, full, _ = s.next(now.Add(4 * time.Second))
	if !full {
		t.Fatal("idle tree not refreshed")
	}
}

func TestAccessibilityAndScrollStormsRemainBounded(t *testing.T) {
	s := scheduler{}
	now := time.Now()
	for i := 0; i < 5000; i++ {
		s.add(action{Kind: "accessibility.changed", Window: "1", PID: 1}, now)
	}
	if len(s.pending) != 1 {
		t.Fatalf("change queue unbounded: %d", len(s.pending))
	}
	for i := 0; i < 100; i++ {
		s.add(action{Kind: "mouse.scroll", Window: "1", PID: 1, Delta: 120}, now)
	}
	if len(s.pending) != 2 || s.pending[1].Delta != 12000 {
		t.Fatal("scroll events not coalesced")
	}
	for i := 0; i < 50; i++ {
		s.add(action{Kind: "mouse.click", Window: "1", PID: 1}, now)
	}
	if len(s.pending) > 16 || s.dropped == 0 {
		t.Fatal("action queue overflow not bounded")
	}
}

func sampleEnvelope(mode string, complete bool) map[string]any {
	return map[string]any{"id": 1, "ok": true, "skipped": false, "readFailures": 0, "event": map[string]any{
		"kind": "sampling.changed", "timestamp": "2026-10-13T12:00:00Z", "app": map[string]any{"bundleIdentifier": "win32.chrome", "pid": 10, "secureInput": false},
		"window": map[string]any{"browser": true, "windowId": "100", "processId": 10, "browserContext": map[string]any{"url": "https://example.com/", "documentUrl": "https://example.com/", "mode": mode, "complete": complete, "windowId": "100", "processId": 10}},
		"ax":     map[string]any{"mode": "fullTree", "text": "ControlType.Text||Example|||"},
	}}
}
func encoded(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestBrowserEventsAreKeptWhateverTheirBrowsingMode(t *testing.T) {
	for _, mode := range []string{"private", "unknown", "", "normal"} {
		for _, complete := range []bool{false, true} {
			if _, err := parseResult(encoded(t, sampleEnvelope(mode, complete)), 1); err != nil {
				t.Fatalf("mode %q complete %v rejected: %v", mode, complete, err)
			}
		}
	}
	value := sampleEnvelope("unknown", false)
	context := value["event"].(map[string]any)["window"].(map[string]any)["browserContext"].(map[string]any)
	context["url"], context["documentUrl"] = "", ""
	if _, err := parseResult(encoded(t, value), 1); err != nil {
		t.Fatalf("event without a page address rejected: %v", err)
	}
}

func TestBrowserAddressMustBeTheCommittedWebURIOfTheForegroundWindow(t *testing.T) {
	for name, change := range map[string]func(map[string]any, map[string]any){
		"missing context": func(window, _ map[string]any) { delete(window, "browserContext") },
		"other window":    func(_, context map[string]any) { context["windowId"] = "200" },
		"other process":   func(_, context map[string]any) { context["processId"] = 11 },
		"non-web address": func(_, context map[string]any) {
			context["url"], context["documentUrl"] = "chrome://settings", "chrome://settings"
		},
		"uncommitted value": func(_, context map[string]any) { context["documentUrl"] = "https://other.example/" },
		"missing address":   func(_, context map[string]any) { delete(context, "url") },
	} {
		value := sampleEnvelope("unknown", true)
		window := value["event"].(map[string]any)["window"].(map[string]any)
		change(window, window["browserContext"].(map[string]any))
		if _, err := parseResult(encoded(t, value), 1); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestWorkerIdentityAndBudgets(t *testing.T) {
	if _, err := parseResult(encoded(t, sampleEnvelope("normal", true)), 2); err == nil {
		t.Fatal("wrong request accepted")
	}
	if _, err := parseResult(make([]byte, maxProtocolBytes+1), 1); err == nil {
		t.Fatal("oversize accepted")
	}
	value := sampleEnvelope("normal", true)
	event := value["event"].(map[string]any)
	event["ax"].(map[string]any)["text"] = strings.Repeat("a", maxTextCharacters+1)
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("text budget exceeded")
	}
	event["ax"].(map[string]any)["text"] = ""
	event["app"].(map[string]any)["secureInput"] = true
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("secure input accepted")
	}
}

func TestSkippedWorkerNeverLeaksAttachedEvent(t *testing.T) {
	value := sampleEnvelope("normal", true)
	value["skipped"] = true
	r, err := parseResult(encoded(t, value), 1)
	if err != nil || r.Event != nil {
		t.Fatal("skipped event propagated")
	}
}

func TestFullSnapshotFailuresCannotBeHiddenBySuccessfulActions(t *testing.T) {
	complete, err := parseResult(encoded(t, sampleEnvelope("normal", true)), 1)
	if err != nil {
		t.Fatal(err)
	}
	partial := workerResult{OK: true, Event: map[string]any{"ax": map[string]any{"windowKey": "100"}}}
	for _, failure := range []struct {
		name   string
		full   bool
		result workerResult
		err    error
	}{
		{"full worker exception", true, workerResult{Skipped: true, ReadFailures: 1}, nil},
		{"worker promoted partial read to failing full read", false, workerResult{Skipped: true, SnapshotAttempted: true, ReadFailures: 1}, nil},
		{"full timeout", true, workerResult{}, errors.New("deadline")},
		{"full response lacks tree", true, partial, nil},
		{"worker promoted probe lacks tree", false, workerResult{OK: true, SnapshotAttempted: true, Event: partial.Event}, nil},
		{"partial provider read", false, workerResult{OK: true, ReadFailures: 1, Event: complete.Event}, nil},
		{"empty tree", false, workerResult{OK: true, Event: map[string]any{"ax": map[string]any{"mode": "fullTree", "text": " "}}}, nil},
	} {
		t.Run(failure.name, func(t *testing.T) {
			if !snapshotFailed(failure.full, failure.result, failure.err) {
				t.Fatal("snapshot loss was not diagnosed")
			}
			// Successful action-only reads emit no snapshot recovery signal.
			// The consumer's failure remains sticky until it persists a real tree.
			if snapshotFailed(false, partial, nil) {
				t.Fatal("ordinary partial action was mislabeled as a full-read failure")
			}
			if snapshotFailed(true, complete, nil) {
				t.Fatal("complete readable tree remained failed")
			}
		})
	}
	if snapshotFailed(true, workerResult{OK: true, Skipped: true, Reason: "secure_input"}, nil) {
		t.Fatal("intentional privacy skip reported as broken capture")
	}
	partial.SnapshotDeferred = true
	if snapshotFailed(true, partial, nil) {
		t.Fatal("worker's completion-based full-tree throttle was reported as failure")
	}
	partial.OK = false
	if !snapshotFailed(true, partial, nil) {
		t.Fatal("defer flag masked a real worker failure")
	}
}

func TestSnapshotQualitySurvivesNativeEventEmission(t *testing.T) {
	result, err := parseResult(encoded(t, sampleEnvelope("normal", true)), 1)
	if err != nil {
		t.Fatal(err)
	}
	result.Truncated, result.ReadFailures = true, 3
	attachSnapshotQuality(&result)
	ax := result.Event["ax"].(map[string]any)
	if ax["truncated"] != true || ax["readFailures"] != 3 {
		t.Fatal("frame quality disappeared before emitting the event")
	}
	partial := workerResult{OK: true, Event: map[string]any{"ax": map[string]any{"windowKey": "100"}}}
	attachSnapshotQuality(&partial)
	if _, present := partial.Event["ax"].(map[string]any)["truncated"]; present {
		t.Fatal("action-only response pretended to carry a tree quality measurement")
	}
}

func TestMalformedSnapshotCannotPassTheNativeProtocol(t *testing.T) {
	for _, ax := range []map[string]any{
		{"text": "content without the fullTree discriminator"},
		{"mode": "fullTree"},
		{"mode": "fullTree", "text": []string{"wrong type"}},
		{"mode": "diffFromPrevious", "text": "+ unsupported native delta"},
	} {
		value := sampleEnvelope("normal", true)
		value["event"].(map[string]any)["ax"] = ax
		if _, err := parseResult(encoded(t, value), 1); err == nil {
			t.Fatalf("invalid native snapshot accepted: %+v", ax)
		}
	}
}

func TestDeferredSnapshotProtocolIsExplicitAndConsistent(t *testing.T) {
	deferred := sampleEnvelope("normal", true)
	deferred["snapshotDeferred"] = true
	deferred["event"].(map[string]any)["ax"] = map[string]any{"windowKey": "100"}
	parsed, err := parseResult(encoded(t, deferred), 1)
	if err != nil || !parsed.SnapshotDeferred || snapshotFailed(true, parsed, err) {
		t.Fatalf("legitimately deferred full request rejected: %+v %v", parsed, err)
	}
	deferred["snapshotAttempted"] = true
	if _, err := parseResult(encoded(t, deferred), 1); err == nil {
		t.Fatal("deferred and attempted snapshot accepted together")
	}
	delete(deferred, "snapshotAttempted")
	deferred["event"].(map[string]any)["ax"] = map[string]any{"mode": "fullTree", "text": "visible text"}
	if _, err := parseResult(encoded(t, deferred), 1); err == nil {
		t.Fatal("deferred snapshot carrying a full tree accepted")
	}
}

func TestSnapshotObservationBindingRequiresAFullTreeAndValidTime(t *testing.T) {
	value := sampleEnvelope("normal", true)
	ax := value["event"].(map[string]any)["ax"].(map[string]any)
	ax["observedAt"] = "2026-10-15T14:00:00.1234567Z"
	result, err := parseResult(encoded(t, value), 1)
	if err != nil || result.Event["ax"].(map[string]any)["observedAt"] != ax["observedAt"] {
		t.Fatal("snapshot observation timestamp lost")
	}
	for _, invalid := range []any{"invalid", "0001-01-01T00:00:00Z", 100} {
		ax["observedAt"] = invalid
		if _, err := parseResult(encoded(t, value), 1); err == nil {
			t.Fatalf("invalid snapshot observation accepted: %v", invalid)
		}
	}
	value["event"].(map[string]any)["ax"] = map[string]any{"windowKey": "100", "observedAt": "2026-10-15T14:00:00Z"}
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("action-only read pretended to establish a full snapshot observation")
	}
}

func TestFullSnapshotsReachAuthorizedConsumerAfterUnchangedOrPartialReads(t *testing.T) {
	result, err := parseResult(encoded(t, sampleEnvelope("normal", true)), 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"same visible text", ""} {
		result.Event["ax"].(map[string]any)["text"] = text
		for _, partial := range []bool{true, false, false} {
			result.Truncated = partial
			result.ReadFailures = 0
			if partial {
				result.ReadFailures = 1
			}
			attachSnapshotQuality(&result)
			if !shouldForwardSample(result.Event, "100") {
				t.Fatal("full snapshot lost before Node authorization/persistence")
			}
		}
	}
	partial := map[string]any{"kind": "sampling.changed", "window": map[string]any{"windowId": "100"}, "ax": map[string]any{"windowKey": "100"}}
	if shouldForwardSample(partial, "100") {
		t.Fatal("idle probe without a snapshot needlessly forwarded")
	}
	if !shouldForwardSample(partial, "200") {
		t.Fatal("window transition was discarded")
	}
	partial["kind"] = "mouse.click"
	if !shouldForwardSample(partial, "100") {
		t.Fatal("action without a full tree was discarded")
	}
}

func TestLostActionsProduceOnlyBoundedContentFreeCoverage(t *testing.T) {
	a := action{Kind: "mouse.click", Timestamp: "2026-10-15T14:00:00.123Z", Button: "left", Count: 1,
		Window: "PRIVATE_WINDOW", PID: 100, X: 9876, Y: 5432, Key: "PRIVATE_KEY", ExpectedURL: "https://private.example/"}
	for _, reason := range []string{"action_origin_unknown", "action_origin_expired", "action_origin_changed", "foreground_changed", "navigation_changed", "focus_changed"} {
		gap := actionCaptureGap(a, workerResult{OK: true, Skipped: true, Reason: reason}, nil)
		if gap == nil || gap["actionTimestamp"] != a.Timestamp || gap["actionKind"] != a.Kind || gap["button"] != a.Button || gap["count"] != 1 || gap["reason"] != reason {
			t.Fatalf("lost action disappeared: %s %+v", reason, gap)
		}
		if len(gap) != 6 || strings.Contains(string(encoded(t, gap)), "PRIVATE") || strings.Contains(string(encoded(t, gap)), "private.example") {
			t.Fatal("coverage exposed context that could not be authorized")
		}
	}
	if gap := actionCaptureGap(a, workerResult{}, errors.New("PRIVATE_PROVIDER_ERROR")); gap["reason"] != "worker_failed" {
		t.Fatal("worker failure was not preserved as a content-free gap")
	}
	for _, reason := range []string{"secure_input", "wechat_consent_required", "unchanged", "unrecognized_PRIVATE_REASON"} {
		if actionCaptureGap(a, workerResult{OK: true, Skipped: true, Reason: reason}, nil) != nil {
			t.Fatalf("intentional exclusion or unknown reason produced a record: %s", reason)
		}
	}
	a.Timestamp = "invalid"
	if actionCaptureGap(a, workerResult{}, errors.New("failure")) != nil {
		t.Fatal("invalid action time accepted")
	}
}

func TestEmbeddedWorkerHasNoScreenshotOrRawKeyboardConversion(t *testing.T) {
	content := string(workerSource)
	for _, word := range []string{"CopyFromScreen", "BitBlt", "ToUnicode", "GetKeyboardState", "keybd_event", "SendKeys"} {
		if strings.Contains(content, word) {
			t.Fatalf("unexpected screenshot/input API %s", word)
		}
	}
	for _, required := range []string{"120000", "$visited -lt 400", "navigation_changed", "wechat_consent_required", "secure_input", "foreground_changed", "focus_changed", "selection=@", "'typing'", "$SelfTest"} {
		if !strings.Contains(content, required) {
			t.Fatalf("worker contract lost: %s", required)
		}
	}
}

func TestCheckpointFlushesTypingBeforeIdleDeadline(t *testing.T) {
	s := scheduler{}
	now := time.Now()
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "123", PID: 42}, now)
	if s.typing == nil {
		t.Fatal("fixture did not queue typing")
	}
	s.flushTyping()
	a, _, ok := s.next(now)
	if !ok || a.Kind != "keyboard.keydown" || a.Count != 1 || s.typing != nil {
		t.Fatal("checkpoint left a pending typing burst")
	}
	s.flushTyping()
	if len(s.pending) != 0 {
		t.Fatal("repeated checkpoint duplicated an action")
	}
}
