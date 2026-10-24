package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"
)

func fixturePNG(t *testing.T, width, height int, changed image.Rectangle) string {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			value := color.NRGBA{20, 40, 60, 255}
			if image.Pt(x, y).In(changed) {
				value = color.NRGBA{240, 240, 240, 255}
			}
			img.SetNRGBA(x, y, value)
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(out.Bytes())
}

func fixtureSnapshot(t *testing.T, windowID int64) *appSnapshot {
	return &appSnapshot{App: appDescriptor{Name: "WPS", PID: 234}, TargetWindowID: windowID,
		WindowTitle: "Presentation", WindowBounds: &frame{X: 100, Y: 200, Width: 200, Height: 100},
		ScreenshotPNGBase64: fixturePNG(t, 200, 100, image.Rectangle{}), ScreenshotIsolated: true, AccessibilityTreeComplete: true,
		TreeLines: []string{"1: Button New"}, Elements: []elementRecord{
			{Index: 1, RuntimeID: []int{42, 1}, Name: "New", ControlType: "Button", StateSignature: "complete-own-state", ContextProof: "complete-document-context", ContextScoped: true},
			{Index: 0, RuntimeID: []int{42, 100}, ControlType: "ControlType.Document", StateSignature: "complete-document-state", ContextProof: "complete-document-context", ContextScoped: true},
		}, ObservationID: "observed"}
}

func cloneSnapshot(value *appSnapshot) *appSnapshot { copy := *value; return &copy }

func TestObservationBindingRejectsLossyWindowAndTokenValues(t *testing.T) {
	for _, value := range []any{nil, 0, -1, 1.5, "123", float64(maxWindowID) + 1, json.Number("9007199254740992")} {
		if _, err := parseObservationBinding(map[string]any{"window_id": value}); err == nil {
			t.Fatalf("accepted window ID %#v", value)
		}
	}
	for _, value := range []any{nil, 123, "", strings.Repeat("x", 129)} {
		if _, err := parseObservationBinding(map[string]any{"observation_id": value}); err == nil {
			t.Fatalf("accepted token %#v", value)
		}
	}
	got, err := parseObservationBinding(map[string]any{"window_id": json.Number("4294967297"), "observation_id": "token"})
	if err != nil || got.WindowID != 4294967297 {
		t.Fatalf("safe HWND rejected: %+v %v", got, err)
	}
}

type snapshotChange func(s *service, fresh *appSnapshot)

func dispatchAfter(t *testing.T, change snapshotChange, act func(*service) toolCallResult) (toolCallResult, int) {
	t.Helper()
	cached := fixtureSnapshot(t, 345)
	fresh := cloneSnapshot(cached)
	fresh.Elements = append([]elementRecord{}, cached.Elements...)
	s := newService()
	s.rememberSnapshot("WPS", cached)
	s.binding = observationBinding{WindowID: 345, ObservationID: cached.ObservationID}
	change(s, fresh)
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if calls == 1 && (request.Tool != "get_app_state" || request.WindowID != 345 || request.ExpectedPID != 234) {
			t.Fatalf("unexpected preflight %+v", request)
		}
		return &psResponse{OK: true, Snapshot: cloneSnapshot(fresh)}, nil
	}
	return act(s), calls
}

func clickElement(s *service) toolCallResult {
	return s.click("WPS", "1", nil, nil, 1, "left", "auto", false)
}
func clickPoint(s *service) toolCallResult {
	return s.click("WPS", "", ptrNumber(10), ptrNumber(20), 1, "left", "auto", false)
}

func liveAppChurn() map[string]snapshotChange {
	return map[string]snapshotChange{
		"title": func(_ *service, fresh *appSnapshot) { fresh.WindowTitle = "Presentation - Saved" },
		"moved window": func(_ *service, fresh *appSnapshot) {
			fresh.WindowBounds = &frame{X: 300, Y: 260, Width: 200, Height: 100}
		},
		"focus":     func(_ *service, fresh *appSnapshot) { fresh.FocusedSummary = "another child" },
		"selection": func(_ *service, fresh *appSnapshot) { fresh.SelectedText = "new selection" },
		"tree": func(_ *service, fresh *appSnapshot) {
			fresh.TreeLines = []string{"1: Button New", "9: Text update banner"}
		},
		"partial tree": func(_ *service, fresh *appSnapshot) { fresh.AccessibilityTreeComplete = false },
		"label and value": func(_ *service, fresh *appSnapshot) {
			fresh.Elements[0].Name, fresh.Elements[0].Value = "New (2)", "changed"
		},
		"state":         func(_ *service, fresh *appSnapshot) { fresh.Elements[0].StateSignature = "changed complete state" },
		"document text": func(_ *service, fresh *appSnapshot) { fresh.Elements[0].ContextProof = "document text changed" },
		"missing proofs": func(_ *service, fresh *appSnapshot) {
			fresh.Elements[0].StateSignature, fresh.Elements[0].ContextProof = "", ""
		},
		"keyboard receiver": func(_ *service, fresh *appSnapshot) {
			fresh.KeyboardReceiverID, fresh.KeyboardReceiverRuntimeID, fresh.KeyboardReceiverState = 1234, []int{12, 34}, "caret changed"
		},
		"recreated popup": func(_ *service, fresh *appSnapshot) {
			fresh.RelatedWindowIDs, fresh.CaptureGroupProof = []int64{11002}, "recreated helper window"
		},
	}
}

func TestElementAndCoordinateActionsIgnoreLiveAppChurn(t *testing.T) {
	for actName, act := range map[string]func(*service) toolCallResult{"element": clickElement, "coordinate": clickPoint} {
		for name, change := range liveAppChurn() {
			t.Run(actName+" "+name, func(t *testing.T) {
				result, calls := dispatchAfter(t, change, act)
				if result.IsError || calls != 2 || result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] == true {
					t.Fatalf("live churn withheld the action: calls=%d result=%+v", calls, result)
				}
			})
		}
	}
}

func TestElementActionWithheldWhenTheObservationOrUIAObjectIsGone(t *testing.T) {
	for name, change := range map[string]snapshotChange{
		"unretained token": func(s *service, _ *appSnapshot) { s.binding.ObservationID = "prior-turn" },
		"missing":          func(_ *service, fresh *appSnapshot) { fresh.Elements = fresh.Elements[1:] },
		"runtime ID":       func(_ *service, fresh *appSnapshot) { fresh.Elements[0].RuntimeID = []int{99, 1} },
		"control type":     func(_ *service, fresh *appSnapshot) { fresh.Elements[0].ControlType = "Text" },
	} {
		t.Run(name, func(t *testing.T) {
			result, calls := dispatchAfter(t, change, clickElement)
			if result.IsError || calls != 1 || result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] != true {
				t.Fatalf("redirected element action was not withheld: calls=%d result=%+v", calls, result)
			}
		})
	}
}

func TestCoordinateActionWithheldForAnotherObservationTargetOrSize(t *testing.T) {
	for name, change := range map[string]snapshotChange{
		"unretained token": func(s *service, _ *appSnapshot) { s.binding.ObservationID = "prior-turn" },
		"process":          func(_ *service, fresh *appSnapshot) { fresh.App.PID = 235 },
		"window":           func(_ *service, fresh *appSnapshot) { fresh.TargetWindowID = 346 },
		"resized window": func(_ *service, fresh *appSnapshot) {
			fresh.WindowBounds = &frame{X: 100, Y: 200, Width: 300, Height: 100}
			fresh.ScreenshotPNGBase64 = fixturePNG(t, 300, 100, image.Rectangle{})
		},
		"bounds disagree with image": func(_ *service, fresh *appSnapshot) {
			fresh.WindowBounds = &frame{X: 100, Y: 200, Width: 300, Height: 100}
		},
	} {
		t.Run(name, func(t *testing.T) {
			result, calls := dispatchAfter(t, change, clickPoint)
			if calls != 1 || (!result.IsError && result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] != true) {
				t.Fatalf("redirected coordinate action was not withheld: calls=%d result=%+v", calls, result)
			}
		})
	}
}

func TestCoordinateActionCarriesNativePopupGeometryProof(t *testing.T) {
	s := newService()
	cached := fixtureSnapshot(t, 345)
	cached.RelatedWindowIDs = []int64{346}
	cached.CaptureGroupProof = `[{"id":345,"processId":234},{"id":346,"owner":345,"left":120}]`
	s.rememberSnapshot("WPS", cached)
	s.runner = func(request psRequest) (*psResponse, error) {
		if request.Tool != "get_app_state" {
			t.Fatalf("prepareAction dispatched unexpected tool: %s", request.Tool)
		}
		return &psResponse{OK: true, Snapshot: cloneSnapshot(cached)}, nil
	}
	request, result := s.prepareAction("WPS", psRequest{Tool: "click", X: ptrNumber(50), Y: ptrNumber(40)})
	if request == nil || result.IsError || request.ObservedCaptureGroupProof != cached.CaptureGroupProof || len(request.RelatedWindowIDs) != 1 || request.RelatedWindowIDs[0] != 346 {
		t.Fatalf("native popup image geometry lost before dispatch: %+v %+v", request, result)
	}
	encoded, err := json.Marshal(request)
	if err != nil || !bytes.Contains(encoded, []byte(`"observed_capture_group_proof":`)) {
		t.Fatalf("PowerShell request omitted native capture proof: %s %v", encoded, err)
	}
}

func TestOwnedPopupMetadataSurvivesNativeJSONAndExplicitlyClearsOnClose(t *testing.T) {
	var snapshot appSnapshot
	if err := json.Unmarshal([]byte(`{"app":{"pid":234},"targetWindowID":345,"relatedWindowIDs":[346,347]}`), &snapshot); err != nil {
		t.Fatal(err)
	}
	meta := snapshot.result().Meta["memmyComputerUse"].(map[string]any)
	ids, ok := meta["relatedWindowIDs"].([]int64)
	if !ok || len(ids) != 2 || ids[0] != 346 || ids[1] != 347 {
		t.Fatalf("owned popup scope lost: %+v", meta)
	}
	snapshot.RelatedWindowIDs = nil
	data, err := json.Marshal(snapshot.result())
	if err != nil || !bytes.Contains(data, []byte(`"relatedWindowIDs":[]`)) {
		t.Fatalf("popup closure did not explicitly clear preview scope: %s %v", data, err)
	}
}

func TestTransportFailureAfterActionAttemptNeverPromisesNoDispatch(t *testing.T) {
	s := newService()
	cached := fixtureSnapshot(t, 345)
	s.rememberSnapshot("WPS", cached)
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool == "get_app_state" {
			return &psResponse{OK: true, Snapshot: cloneSnapshot(cached)}, nil
		}
		return nil, fmt.Errorf("native response timed out")
	}
	result := s.click("WPS", "1", nil, nil, 1, "left", "auto", false)
	if calls != 2 || !result.IsError || result.Meta["memmyComputerUse"].(map[string]any)["noReplay"] != true || !strings.Contains(result.Content[0].Text, "may already have been sent") {
		t.Fatalf("uncertain action accepted %+v", result)
	}
}

func TestSharedDeadlinePreventsMutationAfterSlowObservation(t *testing.T) {
	s := newService()
	cached := fixtureSnapshot(t, 345)
	s.rememberSnapshot("WPS", cached)
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool != "get_app_state" {
			t.Fatal("expired mutation dispatched")
		}
		time.Sleep(30 * time.Millisecond)
		return &psResponse{OK: true, Snapshot: cloneSnapshot(cached)}, nil
	}
	result := s.callTool("click", map[string]any{"app": "WPS", "window_id": 345, "observation_id": "observed", "element_index": 1, "_host_deadline_epoch_ms": time.Now().Add(15 * time.Millisecond).UnixMilli()})
	if calls != 1 || !result.IsError || !strings.Contains(result.Content[0].Text, "deadline expired") {
		t.Fatalf("expired action accepted %+v", result)
	}
}

func TestMCPStopCancelsPreflightBeforeMutation(t *testing.T) {
	for _, kind := range []string{"EOF", "cancel notification"} {
		t.Run(kind, func(t *testing.T) {
			s := newService()
			cached := fixtureSnapshot(t, 345)
			s.rememberSnapshot("WPS", cached)
			input, writer := io.Pipe()
			defer input.Close()
			defer writer.Close()
			started := make(chan struct{})
			finished := make(chan error, 1)
			calls := 0
			s.runner = func(request psRequest) (*psResponse, error) {
				calls++
				if request.Tool != "get_app_state" {
					t.Fatal("cancelled operation sent mutation")
				}
				if request.ctx == nil {
					t.Fatal("missing native context")
				}
				close(started)
				<-request.ctx.Done()
				return nil, request.ctx.Err()
			}
			var output bytes.Buffer
			go func() { finished <- runMCPService(input, &output, s) }()
			if err := json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "click", "arguments": map[string]any{"app": "WPS", "window_id": 345, "observation_id": "observed", "element_index": 1}}}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("preflight did not start")
			}
			if kind == "cancel notification" {
				if err := json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 2}}); err != nil {
					t.Fatal(err)
				}
			}
			writer.Close()
			select {
			case err := <-finished:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("stop did not cancel native operation")
			}
			if calls != 1 || !strings.Contains(output.String(), "cancel") {
				t.Fatalf("stop result calls=%d output=%s", calls, output.String())
			}
		})
	}
}

func TestKeyboardReceiverObservationIsForwardedUnchanged(t *testing.T) {
	s := newService()
	cached := fixtureSnapshot(t, 345)
	cached.KeyboardReceiverID = 777
	cached.KeyboardReceiverRuntimeID = []int{11, 77}
	cached.KeyboardReceiverState = "selection:3,3"
	s.rememberSnapshot("WPS", cached)
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool == "type_text" && (request.ObservedKeyboardReceiverID != 777 || len(request.ObservedKeyboardReceiverRuntimeID) != 2) {
			t.Fatalf("unbound keyboard dispatch %+v", request)
		}
		return &psResponse{OK: true, Snapshot: cloneSnapshot(cached)}, nil
	}
	if result := s.typeText("WPS", "text", false); result.IsError || calls != 2 {
		t.Fatalf("keyboard binding result %+v", result)
	}
}

func TestCoordinateROIRejectsChangedTargetButAllowsRemoteAnimation(t *testing.T) {
	for _, action := range []struct {
		name     string
		dispatch func(*service) toolCallResult
	}{
		{"click", func(s *service) toolCallResult {
			return s.click("WPS", "", ptrNumber(10), ptrNumber(20), 1, "left", "auto", false)
		}},
		{"scroll", func(s *service) toolCallResult {
			return s.scroll("WPS", "down", "", ptrNumber(10), ptrNumber(20), 1)
		}},
		{"drag", func(s *service) toolCallResult {
			return s.drag("WPS", ptrNumber(10), ptrNumber(20), ptrNumber(60), ptrNumber(20))
		}},
	} {
		t.Run(action.name, func(t *testing.T) {
			for _, test := range []struct {
				name       string
				changed    image.Rectangle
				dispatched bool
			}{
				{"changed target", image.Rect(0, 0, 90, 60), false},
				{"remote animation", image.Rect(150, 70, 200, 100), true},
			} {
				t.Run(test.name, func(t *testing.T) {
					cached := fixtureSnapshot(t, 345)
					fresh := cloneSnapshot(cached)
					fresh.TreeLines = []string{"1: Button New", "2: Text new banner"}
					fresh.Elements = append(append([]elementRecord{}, cached.Elements...), elementRecord{Index: 2, RuntimeID: []int{42, 2}, Name: "new banner", ControlType: "Text", Frame: &frame{X: 150, Y: 70, Width: 50, Height: 30}})
					fresh.ScreenshotPNGBase64 = fixturePNG(t, 200, 100, test.changed)
					s := newService()
					s.rememberSnapshot("WPS", cached)
					s.binding = observationBinding{WindowID: 345, ObservationID: "observed"}
					calls := 0
					s.runner = func(request psRequest) (*psResponse, error) {
						calls++
						if calls == 1 && request.Tool != "get_app_state" {
							t.Fatal("missing preflight")
						}
						if calls == 2 && request.Tool != action.name {
							t.Fatalf("unexpected mutation %s", request.Tool)
						}
						return &psResponse{OK: true, Snapshot: cloneSnapshot(fresh)}, nil
					}
					result := action.dispatch(s)
					want := 1
					if test.dispatched {
						want = 2
					}
					if result.IsError || calls != want {
						t.Fatalf("calls=%d result=%+v", calls, result)
					}
					if !test.dispatched && result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] != true {
						t.Fatalf("changed target did not report no dispatch: %+v", result)
					}
				})
			}
		})
	}
}

func TestCoordinatesNeedNeitherACompleteTreeNorUnchangedDocuments(t *testing.T) {
	for _, change := range []string{"partial tree", "document runtime", "document state", "document context", "proof lost", "unrelated churn"} {
		t.Run(change, func(t *testing.T) {
			cached := fixtureSnapshot(t, 345)
			fresh := cloneSnapshot(cached)
			fresh.Elements = append([]elementRecord{}, cached.Elements...)
			switch change {
			case "partial tree":
				cached.AccessibilityTreeComplete, fresh.AccessibilityTreeComplete = false, false
			case "document runtime":
				fresh.Elements[1].RuntimeID = []int{42, 101}
			case "document state":
				fresh.Elements[1].StateSignature = "new-document-content"
			case "document context":
				fresh.Elements[1].ContextProof = "same-title-new-navigation"
			case "proof lost":
				fresh.Elements[1].ContextProof = ""
			case "unrelated churn":
				fresh.TreeLines = []string{"unrelated animated sidebar"}
				fresh.Elements = append(fresh.Elements, elementRecord{Index: 9, RuntimeID: []int{42, 9}, Name: "animated sidebar"})
			}
			s := newService()
			s.rememberSnapshot("WPS", cached)
			s.runner = func(request psRequest) (*psResponse, error) { return &psResponse{OK: true, Snapshot: fresh}, nil }
			prepared, result := s.prepareAction("WPS", psRequest{Tool: "click", X: ptrNumber(10), Y: ptrNumber(20)})
			if prepared == nil || result.IsError {
				t.Fatalf("unchanged coordinate target was withheld: %+v %+v", prepared, result)
			}
		})
	}
}

func TestKeyboardActionsAreSentAcrossTreeAndReceiverStateChurn(t *testing.T) {
	for _, tool := range []string{"type_text", "press_key"} {
		for _, change := range []string{"tree", "element identities", "receiver", "caret", "opaque receiver"} {
			t.Run(tool+" "+change, func(t *testing.T) {
				cached := fixtureSnapshot(t, 345)
				cached.KeyboardReceiverID, cached.KeyboardReceiverRuntimeID = 777, []int{11, 77}
				cached.KeyboardReceiverState = `{"className":"RICHEDIT50W","selection":[3,3]}`
				fresh := cloneSnapshot(cached)
				switch change {
				case "tree":
					fresh.TreeLines = []string{"1: Button New", "2: Text new banner"}
				case "element identities":
					fresh.Elements = append(append([]elementRecord{}, cached.Elements...), elementRecord{Index: 2, RuntimeID: []int{42, 2}, Name: "new banner", ControlType: "Text"})
				case "receiver":
					fresh.KeyboardReceiverID, fresh.KeyboardReceiverRuntimeID = 778, []int{11, 78}
				case "caret":
					fresh.KeyboardReceiverState = `{"className":"RICHEDIT50W","selection":[4,4]}`
				case "opaque receiver":
					fresh.KeyboardReceiverID, fresh.KeyboardReceiverRuntimeID, fresh.KeyboardReceiverState = 0, nil, ""
				}
				s := newService()
				s.rememberSnapshot("WPS", cached)
				s.runner = func(request psRequest) (*psResponse, error) { return &psResponse{OK: true, Snapshot: fresh}, nil }
				prepared, result := s.prepareAction("WPS", psRequest{Tool: tool})
				if prepared == nil || result.IsError {
					t.Fatalf("keyboard input withheld: %+v %+v", prepared, result)
				}
				// The runtime revalidates the receiver focused now, not an older one.
				if prepared.ObservedKeyboardReceiverID != fresh.KeyboardReceiverID {
					t.Fatalf("keyboard dispatch bound to a stale receiver: %+v", prepared)
				}
			})
		}
	}
}

func TestElementActionsResolveObservedIdentityThroughUnrelatedChurn(t *testing.T) {
	for _, tool := range []string{"click", "scroll", "set_value", "perform_secondary_action"} {
		t.Run(tool, func(t *testing.T) {
			cached := fixtureSnapshot(t, 345)
			fresh := cloneSnapshot(cached)
			target := cached.Elements[0]
			target.Index = 7
			fresh.TreeLines = []string{"1: Text rotating banner", "7: Button New"}
			fresh.Elements = []elementRecord{{Index: 1, RuntimeID: []int{42, 99}, Name: "rotating banner"}, target}
			s := newService()
			s.rememberSnapshot("WPS", cached)
			s.runner = func(request psRequest) (*psResponse, error) { return &psResponse{OK: true, Snapshot: fresh}, nil }
			prepared, result := s.prepareAction("WPS", psRequest{Tool: tool, Element: &cached.Elements[0]})
			if prepared == nil || result.IsError || prepared.Element.Index != 7 || prepared.Element.RuntimeID[1] != 1 {
				t.Fatalf("target was not safely rebound through reindex: %+v %+v", prepared, result)
			}
		})
	}
}

func TestElementActionFollowsTheSameUIAObjectThroughStateChanges(t *testing.T) {
	for _, change := range []string{"name", "value", "bounds", "actions", "state", "context", "missing signature", "missing context", "unproven document", "duplicate"} {
		t.Run(change, func(t *testing.T) {
			cached := fixtureSnapshot(t, 345)
			fresh := cloneSnapshot(cached)
			fresh.Elements = append([]elementRecord{}, cached.Elements...)
			target := &fresh.Elements[0]
			switch change {
			case "name":
				target.Name = "New (2)"
			case "value":
				target.Value = "changed"
			case "bounds":
				target.Frame = &frame{X: 20, Y: 30, Width: 40, Height: 50}
			case "actions":
				target.Actions = []string{"Invoke", "Toggle"}
			case "state":
				target.StateSignature = "changed state"
			case "context":
				target.ContextProof = "document text changed"
			case "missing signature":
				target.StateSignature = ""
			case "missing context":
				target.ContextProof = ""
			case "unproven document":
				target.ContextScoped = false
			case "duplicate":
				repeat := *target
				repeat.Index = 9
				fresh.Elements = append(fresh.Elements, repeat)
			}
			s := newService()
			s.rememberSnapshot("WPS", cached)
			s.runner = func(request psRequest) (*psResponse, error) { return &psResponse{OK: true, Snapshot: fresh}, nil }
			prepared, result := s.prepareAction("WPS", psRequest{Tool: "click", Element: &cached.Elements[0]})
			if prepared == nil || result.IsError || prepared.Element.Index != 1 ||
				prepared.Element.Name != fresh.Elements[0].Name || prepared.Element.Frame != fresh.Elements[0].Frame {
				t.Fatalf("same UIA object was not followed to its fresh record: %+v %+v", prepared, result)
			}
		})
	}
}

func TestAnimatedCoordinateTargetIsSentWhenChosenAgain(t *testing.T) {
	for _, retry := range []struct {
		name       string
		x          float64
		dispatched bool
	}{{"same target", 14, true}, {"another target", 120, false}} {
		t.Run(retry.name, func(t *testing.T) {
			cached := fixtureSnapshot(t, 345)
			frames := []string{fixturePNG(t, 200, 100, image.Rect(0, 0, 200, 60)), cached.ScreenshotPNGBase64}
			s := newService()
			s.rememberSnapshot("WPS", cached)
			s.binding = observationBinding{WindowID: 345, ObservationID: cached.ObservationID}
			reads, dispatched := 0, 0
			s.runner = func(request psRequest) (*psResponse, error) {
				fresh := cloneSnapshot(cached)
				if request.Tool == "get_app_state" {
					fresh.ScreenshotPNGBase64 = frames[reads%2]
					reads++
				} else {
					dispatched++
				}
				return &psResponse{OK: true, Snapshot: fresh}, nil
			}
			withheld := clickPoint(s)
			meta := withheld.Meta["memmyComputerUse"].(map[string]any)
			if meta["noActionDispatched"] != true || dispatched != 0 ||
				!strings.Contains(withheld.Content[0].Text, "send it again with this observation_id") {
				t.Fatalf("covered target was not withheld once: %+v", withheld)
			}
			s.binding.ObservationID = meta["observationID"].(string)
			result := s.click("WPS", "", ptrNumber(retry.x), ptrNumber(20), 1, "left", "auto", false)
			if result.IsError || (dispatched == 1) != retry.dispatched {
				t.Fatalf("retry dispatched=%d result=%+v", dispatched, result)
			}
		})
	}
}

func TestNativeTargetProofIsHashedAndRevalidatedAtDispatch(t *testing.T) {
	for _, contract := range []string{
		"function Get-ElementStateSignature", "name = [string]$element.Current.Name", "enabled = [bool]$element.Current.IsEnabled",
		"[string]$live.Current.Value", "[string]$live.Current.ToggleState", "[bool]$live.Current.IsSelected", "GetCurrentSelection()",
		"return Get-StateDigest $state", "stateSignature = $stateSignature", "contextProof = $context.proof", "contextScoped = $context.hasDocumentContext",
		"function Assert-ElementRecordMatches", "[string]$live.controlType -cne [string]$observed.controlType", "-not $script:targetElementValidated", "Find-Element $script:targetRoot",
		"$script:renderContextChains.ContainsKey($key)", "finally { $script:renderContextChains = $null }",
		"$script:treeComplete = $false", "complete = $script:treeComplete", "accessibilityTreeComplete = $rendered.complete",
	} {
		if !strings.Contains(windowsRuntimeScript, contract) {
			t.Fatalf("embedded native runtime lost target-proof contract %q", contract)
		}
	}
}

func TestDesktopFallbackNeverAuthorizesUncalibratedCoordinates(t *testing.T) {
	cached := fixtureSnapshot(t, 345)
	cached.ScreenshotPNGBase64 = ""
	cached.ScreenshotIsolated = false
	s := newService()
	s.rememberSnapshot("WPS", cached)
	s.binding = observationBinding{WindowID: 345, ObservationID: "observed"}
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool != "get_app_state" {
			t.Fatalf("uncalibrated coordinate dispatched %+v", request)
		}
		return &psResponse{OK: true, Snapshot: cloneSnapshot(cached)}, nil
	}
	if result := s.click("WPS", "", ptrNumber(10), ptrNumber(20), 1, "left", "auto", false); result.IsError || calls != 1 || result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] != true {
		t.Fatalf("calls=%d result=%+v", calls, result)
	}
}

func TestUnreliableOrResizedScreenshotsDoNotSendCoordinateInput(t *testing.T) {
	for _, pair := range [][2]string{{"", ""}, {"invalid", "invalid"}, {fixturePNG(t, 200, 100, image.Rectangle{}), fixturePNG(t, 199, 100, image.Rectangle{})}} {
		cached := fixtureSnapshot(t, 345)
		cached.ScreenshotPNGBase64 = pair[0]
		fresh := cloneSnapshot(cached)
		fresh.ScreenshotPNGBase64 = pair[1]
		s := newService()
		s.rememberSnapshot("WPS", cached)
		s.binding = observationBinding{WindowID: 345, ObservationID: "observed"}
		calls := 0
		s.runner = func(request psRequest) (*psResponse, error) {
			calls++
			if request.Tool != "get_app_state" {
				t.Fatal("unreliable image dispatched")
			}
			return &psResponse{OK: true, Snapshot: fresh}, nil
		}
		result := s.click("WPS", "", ptrNumber(10), ptrNumber(20), 1, "left", "auto", false)
		if calls != 1 || result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] != true {
			t.Fatalf("bad image dispatched: %+v", result)
		}
	}
}

func TestDragVerifiesTheMiddleOfThePathBeforeAnyInput(t *testing.T) {
	cached := fixtureSnapshot(t, 345)
	fresh := cloneSnapshot(cached)
	fresh.ScreenshotPNGBase64 = fixturePNG(t, 200, 100, image.Rect(70, 20, 130, 80))
	s := newService()
	s.rememberSnapshot("WPS", cached)
	s.binding = observationBinding{WindowID: 345, ObservationID: "observed"}
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool != "get_app_state" {
			t.Fatal("changed drag path dispatched")
		}
		return &psResponse{OK: true, Snapshot: fresh}, nil
	}
	result := s.drag("WPS", ptrNumber(5), ptrNumber(50), ptrNumber(195), ptrNumber(50))
	if calls != 1 || result.Meta["memmyComputerUse"].(map[string]any)["noActionDispatched"] != true {
		t.Fatalf("changed path accepted: %+v", result)
	}
}

func TestClosedWindowListsChoicesWithoutSelectingANewDocument(t *testing.T) {
	s := newService()
	cached := fixtureSnapshot(t, 345)
	s.rememberSnapshot("WPS", cached)
	s.binding = observationBinding{WindowID: 345, ObservationID: "observed"}
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.WindowID != 345 || request.Tool != "get_app_state" {
			t.Fatal("closed window automatically retargeted")
		}
		return &psResponse{TargetWindowUnavailable: true, RequestedWindowID: 345, PID: 234, Error: "closed target", AvailableWindows: []observedWindow{{WindowID: 346, Title: "New presentation"}}}, nil
	}
	result := s.click("WPS", "1", nil, nil, 1, "left", "auto", false)
	meta := result.Meta["memmyComputerUse"].(map[string]any)
	if !result.IsError || calls != 1 || meta["requestedWindowID"] != int64(345) || len(meta["availableWindows"].([]observedWindow)) != 1 {
		t.Fatalf("closed target accepted: %+v", result)
	}
}

func TestDialogClosedByForegroundKeyReportsTheSentAction(t *testing.T) {
	s := newService()
	cached := fixtureSnapshot(t, 345)
	s.rememberSnapshot("WPS", cached)
	s.binding = observationBinding{WindowID: 345, ObservationID: cached.ObservationID}
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool == "get_app_state" {
			return &psResponse{OK: true, Snapshot: cloneSnapshot(cached)}, nil
		}
		return &psResponse{TargetWindowUnavailable: true, Dispatched: true, RequestedWindowID: 345, PID: 234,
			Error: "closed target", AvailableWindows: []observedWindow{{WindowID: 346, Title: "Document"}}}, nil
	}
	result := s.pressKey("WPS", "Escape", true)
	meta := result.Meta["memmyComputerUse"].(map[string]any)
	if result.IsError || calls != 2 || meta["closedAfterAction"] != true ||
		!strings.Contains(result.Content[0].Text, "window_id=346") {
		t.Fatalf("closed dialog after a sent key was not reported: %+v", result)
	}
}

func TestExactWindowCacheAndProcessRejection(t *testing.T) {
	s := newService()
	first := fixtureSnapshot(t, 345)
	second := fixtureSnapshot(t, 346)
	s.rememberSnapshot("WPS", first)
	s.rememberSnapshot("WPS", second)
	s.binding.WindowID = 345
	if s.currentSnapshot("WPS") != first {
		t.Fatal("same-process window silently substituted")
	}
	s.runner = func(psRequest) (*psResponse, error) {
		copy := cloneSnapshot(first)
		copy.App.PID = 999
		return &psResponse{OK: true, Snapshot: copy}, nil
	}
	result := s.click("WPS", "1", nil, nil, 1, "left", "auto", false)
	if !result.IsError || s.currentSnapshot("WPS") != first {
		t.Fatalf("wrong owner accepted: %+v", result)
	}
	for id := int64(1000); id < 1065; id++ {
		s.rememberSnapshot("window-"+strings.Repeat("x", int(id-1000)), fixtureSnapshot(t, id))
	}
	if len(s.windows) != 64 || len(s.windowOrder) != 64 {
		t.Fatalf("unbounded window cache %d", len(s.windows))
	}
	for _, cached := range s.snapshots {
		if cached.TargetWindowID == 345 || cached.TargetWindowID == 346 {
			t.Fatal("alias retained evicted screenshot")
		}
	}
}

func TestPiPRefreshDoesNotInvalidateUnchangedModelObservation(t *testing.T) {
	s := newService()
	model := fixtureSnapshot(t, 345)
	s.rememberSnapshot("WPS", model)
	pip := cloneSnapshot(model)
	pip.ObservationID = "pip-current"
	s.rememberSnapshot("WPS", pip)
	s.binding = observationBinding{WindowID: 345, ObservationID: "observed"}
	if s.currentSnapshot("WPS") != model {
		t.Fatal("preview refresh replaced model observation")
	}
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		return &psResponse{OK: true, Snapshot: cloneSnapshot(pip)}, nil
	}
	result := s.click("WPS", "1", nil, nil, 1, "left", "auto", false)
	if result.IsError || calls != 2 {
		t.Fatalf("unchanged model action suppressed by PiP: %+v, calls=%d", result, calls)
	}
}

func TestYieldMetadataSeparatesBeforeAndAfterDispatch(t *testing.T) {
	for _, dispatched := range []bool{false, true} {
		result := powerShellErrorResult(&psResponse{FocusGuardYield: true, Dispatched: dispatched, RequestedWindowID: 345, PID: 234})
		meta := result.Meta["memmyComputerUse"].(map[string]any)
		if meta["userYield"].(map[string]any)["dispatched"] != dispatched || meta["targetWindowID"] != int64(345) || strings.Contains(result.Content[0].Text, "WINDOWS_FOCUS_GUARD_STOP") {
			t.Fatalf("incorrect yield %+v", result)
		}
	}
	ordinary := powerShellErrorResult(&psResponse{Error: "queued input then provider failed", Dispatched: true, RequestedWindowID: 345, PID: 234})
	if ordinary.Meta["memmyComputerUse"].(map[string]any)["noReplay"] != true {
		t.Fatal("uncertain dispatched action could be replayed")
	}
}

func TestRevealOnlyAcceptsCompleteExactWindowIdentity(t *testing.T) {
	for _, args := range [][]string{{}, {"--pid", "234"}, {"--pid", "234", "--pid", "345"}, {"--pid", "0", "--window-id", "345"}, {"--pid", "234", "--window-id", "9007199254740992"}} {
		if _, err := parseRevealWindowArgs(args); err == nil {
			t.Fatalf("accepted reveal %+v", args)
		}
	}
	request, err := parseRevealWindowArgs([]string{"--window-id", "4294967297", "--pid", "234"})
	if err != nil || request.WindowID != 4294967297 || request.ExpectedPID != 234 || request.Tool != "reveal_window" {
		t.Fatalf("reveal %+v %v", request, err)
	}
}
