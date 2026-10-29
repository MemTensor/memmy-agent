package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestResolveAppCommandPrintsTheMacCompatibleContract(t *testing.T) {
	var out bytes.Buffer
	runner := func(request psRequest) (*psResponse, error) {
		if request.Tool != "resolve_app" || request.App != "微信" || request.DeadlineEpochMs == 0 {
			t.Fatalf("unexpected request: %+v", request)
		}
		return &psResponse{OK: true, Resolution: &appResolution{Platform: "spoofed", Status: "resolved",
			App: &resolvedApp{AppID: "Weixin", DisplayName: "微信"}}}, nil
	}
	if err := resolveAppCommand([]string{"--query", "微信"}, runner, &out); err != nil {
		t.Fatal(err)
	}
	var printed map[string]any
	if err := json.Unmarshal(out.Bytes(), &printed); err != nil {
		t.Fatal(err)
	}
	app, _ := printed["app"].(map[string]any)
	if printed["platform"] != "win32" || printed["status"] != "resolved" || app["appId"] != "Weixin" || app["displayName"] != "微信" {
		t.Fatalf("resolution contract changed: %s", out.String())
	}
	if _, present := printed["pid"]; present {
		t.Fatalf("an app without a bound window reported a PID: %s", out.String())
	}
	for _, args := range [][]string{{}, {"--query"}, {"微信"}, {"--query", " "}, {"--query", "微信", "--launch"}} {
		if err := resolveAppCommand(args, func(psRequest) (*psResponse, error) {
			t.Fatalf("invalid arguments reached the runtime: %q", args)
			return nil, nil
		}, &out); err == nil {
			t.Fatalf("invalid arguments accepted: %q", args)
		}
	}
}

func TestListAppsCarriesStructuredInstalledIdentity(t *testing.T) {
	const id = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
	s := newService()
	s.runner = func(request psRequest) (*psResponse, error) {
		if request.Tool != "list_apps" {
			t.Fatalf("unexpected request: %+v", request)
		}
		return &psResponse{OK: true, Text: "计算器 -- " + id + " [running, pid=711, process=CalculatorApp]",
			RunningApps: &runningAppListing{Version: 1, Apps: []runningAppIdentity{{AppID: id,
				DisplayName: "计算器", ProcessName: "CalculatorApp", PID: 711, Aliases: []string{"Calculator", "计算器"}}}}}, nil
	}
	result := s.callTool("list_apps", map[string]any{})
	encoded, err := json.Marshal(result)
	if err != nil || result.IsError {
		t.Fatalf("list app result: %+v %v", result, err)
	}
	var wire struct {
		Meta struct {
			Native struct {
				RunningApps runningAppListing `json:"runningApps"`
			} `json:"memmyComputerUse"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	apps := wire.Meta.Native.RunningApps
	if apps.Version != 1 || len(apps.Apps) != 1 || apps.Apps[0].AppID != id || apps.Apps[0].DisplayName != "计算器" || apps.Apps[0].PID != 711 {
		t.Fatalf("structured native identity lost at the MCP boundary: %s", encoded)
	}
}

func TestHostIdentityBindingReachesObservationAndEveryAction(t *testing.T) {
	const id = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
	s := newService()
	var calls []psRequest
	s.runner = func(request psRequest) (*psResponse, error) {
		calls = append(calls, request)
		if request.ExpectedAppID != id {
			t.Fatalf("authorized identity lost on %s: %+v", request.Tool, request)
		}
		return &psResponse{OK: true, Snapshot: fixtureSnapshot(t, 345)}, nil
	}
	state := s.callTool("get_app_state", map[string]any{"app": "234", "_memmy_expected_app_id": id})
	if state.IsError {
		t.Fatalf("initial observation failed: %+v", state)
	}
	result := s.callTool("click", map[string]any{"app": "234", "element_index": 1, "_memmy_expected_app_id": id})
	if result.IsError || len(calls) != 3 || calls[1].Tool != "get_app_state" || calls[2].Tool != "click" {
		t.Fatalf("action and its re-observation did not preserve the app identity: %+v %+v", calls, result)
	}
	if s.binding.ExpectedAppID != "" {
		t.Fatal("host identity escaped its current tool call")
	}
}

func TestInvalidHostApplicationIdentityFailsBeforeRuntime(t *testing.T) {
	for _, value := range []any{nil, 123, "", "Calculator\nInjected", "C:\\Calculator.exe", strings.Repeat("x", 257)} {
		s := newService()
		calls := 0
		s.runner = func(psRequest) (*psResponse, error) { calls++; return &psResponse{}, nil }
		result := s.callTool("get_app_state", map[string]any{"app": "711", "_memmy_expected_app_id": value})
		if !result.IsError || calls != 0 {
			t.Fatalf("invalid app identity reached runtime: %#v %+v", value, result)
		}
	}
	for _, tool := range toolDefinitions() {
		properties := tool.InputSchema["properties"].(map[string]any)
		if _, present := properties["_memmy_expected_app_id"]; present {
			t.Fatalf("host identity binding exposed in model schema: %s", tool.Name)
		}
	}
}

func TestChangedApplicationIdentityReturnsNoActionError(t *testing.T) {
	s := newService()
	calls := 0
	s.runner = func(request psRequest) (*psResponse, error) {
		calls++
		if request.Tool != "get_app_state" || request.ExpectedAppID != "approved!App" {
			t.Fatalf("unexpected request: %+v", request)
		}
		return &psResponse{OK: false, Error: "The target process application identity changed. No further action was sent."}, nil
	}
	result := s.callTool("get_app_state", map[string]any{"app": "711", "_memmy_expected_app_id": "approved!App"})
	if !result.IsError || calls != 1 || !strings.Contains(result.Content[0].Text, "identity changed") {
		t.Fatalf("changed identity was not rejected: %+v", result)
	}
}
