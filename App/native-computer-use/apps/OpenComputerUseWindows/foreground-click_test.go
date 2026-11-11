package main

import (
	"image"
	"strings"
	"testing"
)

// clickService observes window 345 and answers the click with the runtime's
// report and the given post-click state.
func clickService(t *testing.T, after func(*appSnapshot), report psResponse) (*service, *psRequest) {
	t.Helper()
	cached := fixtureSnapshot(t, 345)
	s := newService()
	s.rememberSnapshot("WPS", cached)
	s.binding = observationBinding{WindowID: 345, ObservationID: cached.ObservationID}
	var dispatched psRequest
	s.runner = func(request psRequest) (*psResponse, error) {
		state := cloneSnapshot(cached)
		if request.Tool == "get_app_state" {
			return &psResponse{OK: true, Snapshot: state}, nil
		}
		dispatched = request
		if after != nil {
			after(state)
		}
		response := report
		response.OK, response.Snapshot = true, state
		return &response, nil
	}
	return s, &dispatched
}

func TestWindowsClickSchemaOffersAForegroundBoolean(t *testing.T) {
	properties := findToolDefinition(t, "click").InputSchema["properties"].(map[string]any)
	foreground, ok := properties["foreground"].(map[string]any)
	if !ok || foreground["type"] != "boolean" {
		t.Fatalf("foreground schema = %#v", properties["foreground"])
	}
	description := foreground["description"].(string)
	for _, required := range []string{"ignore window messages", "physical pointer briefly moves", "sends nothing if the user takes over"} {
		if !strings.Contains(description, required) {
			t.Fatalf("foreground description lacks %q: %s", required, description)
		}
	}
}

// Window messages carry text only into native edit controls, so documents and
// web page fields are typed with real input in the foreground.
func TestWindowsTypingAndKeysOfferAForegroundBoolean(t *testing.T) {
	for _, name := range []string{"type_text", "press_key"} {
		properties := findToolDefinition(t, name).InputSchema["properties"].(map[string]any)
		foreground, ok := properties["foreground"].(map[string]any)
		if !ok || foreground["type"] != "boolean" || !strings.Contains(foreground["description"].(string), "pointer does not move") {
			t.Fatalf("%s foreground schema = %#v", name, properties["foreground"])
		}
	}
	for _, test := range []struct {
		tool string
		args map[string]any
	}{
		{"type_text", map[string]any{"app": "WPS", "window_id": 345, "text": "你好上海", "foreground": true}},
		{"press_key", map[string]any{"app": "WPS", "window_id": 345, "key": "ctrl+n", "foreground": true}},
	} {
		s, dispatched := clickService(t, nil, psResponse{ForegroundClick: "returned"})
		result := s.callTool(test.tool, test.args)
		if result.IsError || dispatched.Tool != test.tool || !dispatched.Foreground {
			t.Fatalf("%s foreground was not sent as such: %#v %+v", test.tool, result, dispatched)
		}
		if !strings.Contains(result.Content[0].Text, foregroundHandBackNote("returned")) {
			t.Fatalf("%s result lacks the hand-back: %s", test.tool, result.Content[0].Text)
		}
	}
	s, _ := clickService(t, nil, psResponse{})
	if result := s.callTool("type_text", map[string]any{"app": "WPS", "text": "a", "foreground": "yes"}); !result.IsError {
		t.Fatalf("non-boolean foreground was accepted: %#v", result)
	}
}

func TestADialogThatClosesAfterTheActionIsAResult(t *testing.T) {
	closed := powerShellErrorResult(&psResponse{TargetWindowUnavailable: true, Dispatched: true, RequestedWindowID: 345,
		AvailableWindows: []observedWindow{{WindowID: 101, Title: "WPS Office"}}})
	if closed.IsError || !strings.HasPrefix(closed.Content[0].Text, "The action was sent, and window 345 then closed") ||
		!strings.Contains(closed.Content[0].Text, "- window_id=101 WPS Office") {
		t.Fatalf("closed-after-action result = %#v", closed)
	}
	unsent := powerShellErrorResult(&psResponse{TargetWindowUnavailable: true, Error: "The observed target window is unavailable."})
	if !unsent.IsError || unsent.Content[0].Text != "The observed target window is unavailable." {
		t.Fatalf("unsent unavailable result = %#v", unsent)
	}
	available := powerShellErrorResult(&psResponse{TargetWindowUnavailable: true, RequestedWindowID: 345,
		Error: "The observed target window is unavailable.", AvailableWindows: []observedWindow{{WindowID: 101, Title: "PowerPoint"}}})
	if !available.IsError || !strings.Contains(available.Content[0].Text, "- window_id=101 PowerPoint") {
		t.Fatalf("unavailable observation hid the available window IDs = %#v", available)
	}
}

func TestAClickThatOpensADialogPointsToItsWindow(t *testing.T) {
	before := fixtureSnapshot(t, 345)
	before.AvailableWindows = []observedWindow{{WindowID: 345, Title: "首页"}}
	after := cloneSnapshot(before)
	after.AvailableWindows = []observedWindow{{WindowID: 345, Title: "首页"}, {WindowID: 20674}}
	after.pointerDelivery = "window_message"
	note := clickObservationNote(before, after, false)
	if !strings.HasPrefix(note, "The click opened window_id=20674.") || strings.Contains(note, unchangedClickNote) {
		t.Fatalf("opened-window note = %q", note)
	}
}

func TestForegroundMustBeABooleanAndNeverAnAccessibilityClick(t *testing.T) {
	s, dispatched := clickService(t, nil, psResponse{})
	result := s.callTool("click", map[string]any{"app": "WPS", "window_id": 345, "element_index": "1", "foreground": "yes"})
	if !result.IsError || result.Content[0].Text != "foreground must be a boolean" || dispatched.Tool != "" {
		t.Fatalf("non-boolean foreground = %#v, dispatched %+v", result, dispatched)
	}
	result = s.click("WPS", "1", nil, nil, 1, "left", "accessibility", true)
	if !result.IsError || result.Content[0].Text != "foreground=true sends a pointer click; use click_method auto or app_post" || dispatched.Tool != "" {
		t.Fatalf("accessibility foreground = %#v, dispatched %+v", result, dispatched)
	}
}

func TestForegroundClickReachesTheRuntimeAndReportsTheHandBack(t *testing.T) {
	s, dispatched := clickService(t, func(state *appSnapshot) { state.TreeLines = []string{"1: Editor"} },
		psResponse{PointerDelivery: "foreground_input", ForegroundClick: "returned"})
	result := s.callTool("click", map[string]any{"app": "WPS", "window_id": 345, "x": 50.0, "y": 40.0, "foreground": true})
	if result.IsError || dispatched.Tool != "click" || !dispatched.Foreground {
		t.Fatalf("foreground click was not sent as such: %#v %+v", result, dispatched)
	}
	text := result.Content[0].Text
	if !strings.Contains(text, foregroundHandBackNote("returned")) || strings.Contains(text, "foreground=true") {
		t.Fatalf("foreground result note = %s", text)
	}
}

// A click that only places the text cursor changes nothing visible, so an
// unchanged click is no evidence that background input was ignored.
func TestBackgroundWindowMessageClickThatChangesNothingDoesNotSuggestTheForeground(t *testing.T) {
	s, dispatched := clickService(t, nil, psResponse{PointerDelivery: "window_message"})
	result := s.click("WPS", "", ptrNumber(50), ptrNumber(40), 1, "left", "auto", false)
	if result.IsError || dispatched.Foreground {
		t.Fatalf("background click = %#v %+v", result, dispatched)
	}
	text := result.Content[0].Text
	if !strings.Contains(text, unchangedClickNote) || strings.Contains(text, "foreground") {
		t.Fatalf("unchanged window-message click note = %s", text)
	}
}

func TestClickObservationNotes(t *testing.T) {
	before := fixtureSnapshot(t, 345)
	changedImage := cloneSnapshot(before)
	changedImage.ScreenshotPNGBase64 = fixturePNG(t, 200, 100, image.Rect(10, 10, 20, 20))
	changedTree := cloneSnapshot(before)
	changedTree.TreeLines = []string{"1: Editor"}
	for _, test := range []struct {
		name       string
		after      *appSnapshot
		delivery   string
		foreground bool
		handBack   string
		want       string
	}{
		{"hover only", changedImage, "window_message", false, "", screenshotOnlyClickNote},
		{"opened something", changedTree, "window_message", false, "", ""},
		{"UI Automation", cloneSnapshot(before), "uia", false, "", ""},
		{"foreground changed nothing", cloneSnapshot(before), "foreground_input", true, "keptForUser",
			foregroundUnchangedClickNote + " " + foregroundHandBackNote("keptForUser")},
		{"already active foreground", changedTree, "foreground_input", true, "notNeeded", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.after.pointerDelivery, test.after.foregroundClick = test.delivery, test.handBack
			if got := clickObservationNote(before, test.after, test.foreground); got != test.want {
				t.Fatalf("note = %q, want %q", got, test.want)
			}
		})
	}
}
