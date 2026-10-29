package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

type taskResponseWriter struct {
	bytes.Buffer
	written chan struct{}
}

func (w *taskResponseWriter) Write(p []byte) (int, error) {
	n, err := w.Buffer.Write(p)
	select {
	case w.written <- struct{}{}:
	default:
	}
	return n, err
}

// Independent host-owned helpers may use identical MCP request IDs. Neither
// cancellation nor loss of one helper's stdin may cancel another helper.
func TestIndependentMCPTaskCancellationDoesNotAffectSibling(t *testing.T) {
	for _, stopKind := range []string{"cancel", "EOF"} {
		t.Run(stopKind, func(t *testing.T) {
			first, second := newService(), newService()
			firstInput, firstWriter := io.Pipe()
			secondInput, secondWriter := io.Pipe()
			defer firstInput.Close()
			defer firstWriter.Close()
			defer secondInput.Close()
			defer secondWriter.Close()
			firstStarted, firstCancelled := make(chan struct{}), make(chan struct{})
			secondStarted, secondRelease := make(chan struct{}), make(chan struct{})
			secondCancelled := make(chan struct{})
			snapshot := fixtureSnapshot(t, 345)
			first.runner = func(request psRequest) (*psResponse, error) {
				close(firstStarted)
				<-request.ctx.Done()
				close(firstCancelled)
				return nil, request.ctx.Err()
			}
			second.runner = func(request psRequest) (*psResponse, error) {
				close(secondStarted)
				select {
				case <-request.ctx.Done():
					close(secondCancelled)
					return nil, request.ctx.Err()
				case <-secondRelease:
					return &psResponse{OK: true, Snapshot: snapshot}, nil
				}
			}
			firstOutput := &taskResponseWriter{written: make(chan struct{}, 1)}
			secondOutput := &taskResponseWriter{written: make(chan struct{}, 1)}
			firstFinished, secondFinished := make(chan error, 1), make(chan error, 1)
			go func() { firstFinished <- runMCPService(firstInput, firstOutput, first) }()
			go func() { secondFinished <- runMCPService(secondInput, secondOutput, second) }()
			request := map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{
				"name": "get_app_state", "arguments": map[string]any{"app": "WPS", "window_id": 345},
			}}
			for _, writer := range []*io.PipeWriter{firstWriter, secondWriter} {
				if err := json.NewEncoder(writer).Encode(request); err != nil {
					t.Fatal(err)
				}
			}
			for _, started := range []chan struct{}{firstStarted, secondStarted} {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("task did not start")
				}
			}
			if stopKind == "cancel" {
				if err := json.NewEncoder(firstWriter).Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 2}}); err != nil {
					t.Fatal(err)
				}
			} else {
				firstWriter.Close()
			}
			select {
			case <-firstCancelled:
			case <-time.After(time.Second):
				t.Fatal("owned task was not cancelled")
			}
			select {
			case <-secondCancelled:
				t.Fatal("sibling task was cancelled")
			default:
			}
			close(secondRelease)
			select {
			case <-secondOutput.written:
			case <-time.After(time.Second):
				t.Fatal("sibling did not complete")
			}
			firstWriter.Close()
			secondWriter.Close()
			for _, finished := range []chan error{firstFinished, secondFinished} {
				select {
				case err := <-finished:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(time.Second):
					t.Fatal("helper did not finish")
				}
			}
			if !strings.Contains(firstOutput.String(), "cancel") {
				t.Fatalf("missing owned cancellation: %s", firstOutput.String())
			}
			if !strings.Contains(secondOutput.String(), `"isError":false`) {
				t.Fatalf("sibling did not succeed: %s", secondOutput.String())
			}
		})
	}
}
