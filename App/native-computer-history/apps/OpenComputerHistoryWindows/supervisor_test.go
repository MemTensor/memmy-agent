package main

import (
	"context"
	"errors"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

type testInput struct {
	closed atomic.Bool
	writes atomic.Int32
}

func (i *testInput) Write(p []byte) (int, error) {
	if i.closed.Load() {
		return 0, errors.New("closed")
	}
	i.writes.Add(1)
	return len(p), nil
}
func (i *testInput) Close() error { i.closed.Store(true); return nil }

func TestBlockedProviderDeadlineStopsWorker(t *testing.T) {
	in := &testInput{}
	w := &worker{cmd: &exec.Cmd{}, input: in, lines: make(chan []byte)}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := w.request(ctx, workerRequest{ID: 1})
	if !errors.Is(err, context.DeadlineExceeded) || !in.closed.Load() {
		t.Fatalf("blocked worker not stopped: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("deadline failed to bound request")
	}
	w.stop()
	w.stop() // lifecycle races must be idempotent
}

func TestCancelledOwnerImmediatelyStopsOutstandingRequest(t *testing.T) {
	in := &testInput{}
	w := &worker{cmd: &exec.Cmd{}, input: in, lines: make(chan []byte)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := w.request(ctx, workerRequest{ID: 1})
	if !errors.Is(err, context.Canceled) || !in.closed.Load() {
		t.Fatal("owner cancellation left worker alive")
	}
}

func TestWrongRequestResponseCannotBecomeObservation(t *testing.T) {
	in := &testInput{}
	w := &worker{cmd: &exec.Cmd{}, input: in, lines: make(chan []byte, 1)}
	w.lines <- encoded(t, sampleEnvelope("normal", true))
	_, err := w.request(context.Background(), workerRequest{ID: 2})
	if err == nil {
		t.Fatal("stale response accepted")
	}
}

func TestOriginBindsOnlySameForegroundAndFreshContext(t *testing.T) {
	defer verifiedOrigin.Store(nil)
	verifiedOrigin.Store(&originContext{Window: "100", PID: 1, URL: "https://company.example/", Focus: "field-a", Scope: 7, At: time.Now()})
	a := action{Window: "200", PID: 1}
	bindOrigin(&a)
	if a.OriginVerified {
		t.Fatal("cross-window origin attached")
	}
	a = action{Window: "100", PID: 1}
	bindOrigin(&a)
	if !a.OriginVerified || a.ExpectedURL != "https://company.example/" || a.ExpectedFocus != "field-a" || a.ExpectedScope != 7 {
		t.Fatal("origin not bound")
	}
	verifiedOrigin.Store(&originContext{Window: "100", PID: 1, At: time.Now().Add(-6 * time.Second)})
	a = action{Window: "100", PID: 1}
	bindOrigin(&a)
	if a.OriginVerified {
		t.Fatal("stale origin attached")
	}
}

func TestTypingDoesNotSurviveSameWindowNavigationOrFocusSwitch(t *testing.T) {
	now := time.Now()
	s := scheduler{}
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "100", PID: 1, ExpectedURL: "https://company.example/", ExpectedFocus: "a", ExpectedScope: 2}, now)
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "100", PID: 1, ExpectedURL: "https://shop.example/", ExpectedFocus: "b", ExpectedScope: 3}, now)
	a, _, _ := s.next(now.Add(2 * time.Second))
	if a.Count != 1 || a.ExpectedURL != "https://shop.example/" || a.ExpectedFocus != "b" {
		t.Fatal("old input attributed to new page")
	}
	s.add(action{Kind: "keyboard.keydown", Key: "[typing]", Window: "100", PID: 1}, now)
	s.add(action{Kind: "focus.changed", Window: "100", PID: 1}, now)
	if s.typing != nil {
		t.Fatal("old field burst survived focus change")
	}
}

func TestNativeBrowserContextIsBoundToReportedWindowAndProcess(t *testing.T) {
	for _, field := range []string{"windowId", "processId"} {
		value := sampleEnvelope("normal", true)
		window := value["event"].(map[string]any)["window"].(map[string]any)
		context := window["browserContext"].(map[string]any)
		if field == "windowId" {
			context[field] = "999"
		} else {
			context[field] = 999
		}
		if _, err := parseResult(encoded(t, value), 1); err == nil {
			t.Fatalf("mismatched %s accepted", field)
		}
	}
}

func TestAddressEditingCannotAuthorizeDifferentCommittedDocument(t *testing.T) {
	value := sampleEnvelope("normal", true)
	context := value["event"].(map[string]any)["window"].(map[string]any)["browserContext"].(map[string]any)
	context["documentUrl"] = "https://company.example/"
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("address editing authorized wrong document")
	}
	delete(context, "documentUrl")
	if _, err := parseResult(encoded(t, value), 1); err == nil {
		t.Fatal("missing committed URI accepted")
	}
}
