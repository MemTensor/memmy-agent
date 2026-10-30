package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"time"
)

//go:embed worker.ps1
var workerSource []byte

type worker struct {
	cmd      *exec.Cmd
	input    io.WriteCloser
	lines    chan []byte
	done     chan error
	stopOnce sync.Once
}

func (w *worker) stop() {
	w.stopOnce.Do(func() {
		_ = w.input.Close()
		if w.cmd.Process != nil {
			_ = w.cmd.Process.Kill()
		}
	})
}

func startWorker(ctx context.Context, script string) (*worker, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	cmd := exec.Command(filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		"-NoProfile", "-NonInteractive", "-MTA", "-ExecutionPolicy", "Bypass", "-File", script)
	configureCommand(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		_ = in.Close()
		return nil, err
	}
	// Provider diagnostics can contain user data. Never forward arbitrary stderr.
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		_ = in.Close()
		return nil, err
	}
	w := &worker{cmd: cmd, input: in, lines: make(chan []byte, 1), done: make(chan error, 1)}
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 65536), maxProtocolBytes)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case w.lines <- line:
			default:
				w.stop()
			}
		}
		w.done <- cmd.Wait()
		close(w.lines)
	}()
	select {
	case line := <-w.lines:
		var hello struct {
			Ready     bool   `json:"ready"`
			RuntimeID string `json:"runtimeId"`
		}
		if json.Unmarshal(line, &hello) != nil || !hello.Ready || hello.RuntimeID != runtimeID {
			w.stop()
			return nil, errors.New("worker handshake")
		}
		return w, nil
	case <-time.After(20 * time.Second):
		w.stop()
		return nil, errors.New("worker startup timeout")
	case <-w.done:
		w.stop()
		return nil, errors.New("worker startup exit")
	case <-ctx.Done():
		w.stop()
		return nil, ctx.Err()
	}
}

func (w *worker) request(ctx context.Context, r workerRequest) (workerResult, error) {
	raw, _ := json.Marshal(r)
	if _, err := w.input.Write(append(raw, '\n')); err != nil {
		return workerResult{}, err
	}
	select {
	case line, open := <-w.lines:
		if !open {
			return workerResult{}, errors.New("worker exit")
		}
		return parseResult(line, r.ID)
	case <-ctx.Done():
		w.stop()
		return workerResult{}, ctx.Err()
	}
}

func emit(value any) error { return json.NewEncoder(os.Stdout).Encode(value) }
func diagnostic(code string) {
	_ = emit(map[string]any{"type": "recorder.diagnostic", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "code": code})
}

func diagnosticCount(code string, count int) {
	_ = emit(map[string]any{"type": "recorder.diagnostic", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "code": code, "count": count})
}

func observe(parent int, consent string) error {
	if parent <= 0 {
		return errors.New("parent pid required")
	}
	if err := ensureJob(); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := watchParent(ctx, parent, cancel); err != nil {
		return err
	}
	type checkpointRequest struct {
		Kind    string `json:"kind"`
		ID      string `json:"id"`
		From    string `json:"from"`
		Through string `json:"through"`
	}
	checkpoints := make(chan checkpointRequest, 16)
	// EOF is a lifetime signal as well as an explicit stop. No untrusted stdin
	// instruction can disable native consent checks or introduce typed text.
	go func() {
		s := bufio.NewScanner(os.Stdin)
		s.Buffer(make([]byte, 4096), 65536)
		for s.Scan() {
			var command checkpointRequest
			if json.Unmarshal(s.Bytes(), &command) == nil && command.Kind == "stop" {
				cancel()
				return
			}
			if command.Kind == "checkpoint" && checkpointID.MatchString(command.ID) {
				select {
				case checkpoints <- command:
				case <-ctx.Done():
					return
				}
			}
		}
		cancel()
	}()
	dir, err := os.MkdirTemp("", "memmy-history-worker-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	script := filepath.Join(dir, "worker.ps1")
	// PowerShell 5.1 otherwise interprets a UTF-8 script in the ANSI code page.
	if err := os.WriteFile(script, append([]byte{0xef, 0xbb, 0xbf}, workerSource...), 0600); err != nil {
		return err
	}
	actions := make(chan action, 128)
	coverage := coverageTracker{}
	processStarted := time.Now()
	coverage.begin("observer_starting", processStarted)
	if err := installHooks(ctx, actions); err != nil {
		coverage.begin("input_monitoring_unavailable", processStarted)
		diagnostic("input_monitoring_unavailable")
	}
	var current *worker
	defer func() {
		if current != nil {
			current.stop()
		}
		_ = emit(map[string]any{"kind": "session.ended", "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
	}()
	_ = emit(map[string]any{"kind": "session.started", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "runtimeId": runtimeID})
	diagnostic("heartbeat")
	schedule := scheduler{}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	var sequence uint64
	lastHeartbeat := time.Now()
	restartAt := time.Time{}
	failures := 0
	ready := false
	lastWindow := ""
	type checkpoint struct {
		id                string
		at, from, through time.Time
		ranged            bool
	}
	var pendingCheckpoints []checkpoint
	lastQueueCheck := processStarted
	for {
		// Drain current hooks once; a barrier waits for its own cutoff, not
		// for an indefinitely idle desktop after the user has stopped.
		for count := len(actions); count > 0; count-- {
			schedule.add(<-actions, time.Now())
		}
		now := time.Now()
		hookLoss := hookDropped()
		if schedule.dropped > 0 || hookLoss > 0 {
			from := lastQueueCheck
			if !schedule.droppedFrom.IsZero() && schedule.droppedFrom.Before(from) {
				from = schedule.droppedFrom
			}
			coverage.missing(from, now)
			diagnostic("enrichment_backlog")
			schedule.dropped = 0
			schedule.droppedFrom = time.Time{}
		}
		lastQueueCheck = now
		if len(pendingCheckpoints) > 0 {
			remaining := pendingCheckpoints[:0]
			for _, point := range pendingCheckpoints {
				settled := !schedule.pendingThrough(point.through)
				if settled || time.Since(point.at) >= 8*time.Second {
					if err := emit(map[string]any{"kind": "session.checkpoint", "id": point.id, "complete": settled && coverage.complete(point.from, point.through), "rangeEvaluated": point.ranged, "sequence": sequence}); err != nil {
						return err
					}
				} else {
					remaining = append(remaining, point)
				}
			}
			pendingCheckpoints = remaining
		}
		select {
		case <-ctx.Done():
			return nil
		case request := <-checkpoints:
			at := time.Now()
			from, through := processStarted, at
			ranged := false
			if request.From != "" {
				parsed, parseErr := time.Parse(time.RFC3339Nano, request.From)
				if parseErr != nil {
					continue
				}
				from = parsed
				ranged = true
			}
			if request.Through != "" {
				parsed, parseErr := time.Parse(time.RFC3339Nano, request.Through)
				if parseErr != nil || parsed.Before(from) {
					continue
				}
				through = parsed
			}
			if len(pendingCheckpoints) < 16 {
				pendingCheckpoints = append(pendingCheckpoints, checkpoint{request.ID, at, from, through, ranged})
			}
			// Drain the already queued hooks before sealing the native watermark.
			for count := len(actions); count > 0; count-- {
				schedule.add(<-actions, time.Now())
			}
			schedule.flushTyping()
		case a := <-actions:
			schedule.add(a, time.Now())
		case now := <-tick.C:
			if now.Sub(lastHeartbeat) >= 5*time.Second {
				diagnostic("heartbeat")
				lastHeartbeat = now
			}
			if dropped := schedule.dropped + int(hookDropped()); dropped > 0 {
				diagnosticCount("enrichment_backlog", dropped)
				schedule.dropped = 0
			}
			if now.Before(restartAt) {
				continue
			}
			if current == nil {
				current, err = startWorker(ctx, script)
				if err != nil {
					coverage.begin("observer_unavailable", now)
					diagnostic("observer_unavailable")
					restartAt = now.Add(2 * time.Second)
					continue
				}
			}
			a, full, ok := schedule.next(now)
			if !ok {
				continue
			}
			sequence++
			requestCtx, requestCancel := context.WithTimeout(ctx, workerDeadline)
			result, readErr := current.request(requestCtx, workerRequest{ID: sequence, Action: a, Full: full, ConsentPath: consent})
			requestCancel()
			if snapshotFailed(full, result, readErr) {
				diagnostic("ax_snapshot_failed")
			}
			if gap := actionCaptureGap(a, result, readErr); gap != nil {
				_ = emit(gap)
			}
			if readErr != nil {
				coverage.begin("observer_unavailable", actionTime(a, now))
				current.stop()
				current = nil
				ready = false
				failures++
				if errors.Is(readErr, context.DeadlineExceeded) {
					diagnostic("ax_snapshot_budget_exceeded")
				}
				diagnostic("observer_unavailable")
				restartAt = now.Add(time.Duration(min(failures, 5)) * time.Second)
				lastWindow = ""
				continue
			}
			if result.Truncated {
				coverage.missing(actionTime(a, now), time.Now())
				diagnostic("ax_snapshot_budget_exceeded")
			}
			if !result.OK {
				coverage.begin("observer_unavailable", actionTime(a, now))
				failures++
				if failures >= 2 {
					ready = false
					diagnostic("observer_unavailable")
				}
				continue
			}
			if result.Skipped {
				if len(result.Reason) >= 13 && result.Reason[:13] == "action_origin" {
					schedule.add(action{Kind: "sampling.changed"}, time.Now())
				}
				if result.Reason == "privacy_unknown" {
					coverage.missing(actionTime(a, now), time.Now())
					diagnostic("privacy_unknown")
				}
				if result.Reason != "unchanged" {
					verifiedOrigin.Store(nil)
					lastWindow = ""
				}
				continue
			}
			failures = 0
			coverage.recover("observer_starting", time.Now())
			coverage.recover("observer_unavailable", time.Now())
			if result.ReadFailures > 0 {
				coverage.missing(actionTime(a, now), time.Now())
			}
			if !ready {
				diagnostic("observer_ready")
				ready = true
			}
			event := result.Event
			if event == nil {
				continue
			}
			attachSnapshotQuality(&result)
			rememberOrigin(event)
			window, _ := event["window"].(map[string]any)
			windowID, _ := window["windowId"].(string)
			kind, _ := event["kind"].(string)
			if !shouldForwardSample(event, lastWindow) {
				continue
			}
			if kind == "sampling.changed" {
				if windowID != lastWindow {
					event["kind"] = "window.changed"
				}
			}
			lastWindow = windowID
			if err := emit(event); err != nil {
				return err
			}
		}
	}
}

func main() {
	self := flag.Bool("self-test", false, "pure protocol/scheduler check; never access desktop")
	observeFlag := flag.Bool("observe", false, "record foreground accessibility and actions")
	parent := flag.Int("parent-pid", 0, "owning Node process PID")
	consent := flag.String("wechat-consent", "", "live version 1 WeChat consent file")
	_ = flag.Bool("allow-wechat", false, "deprecated; never overrides live consent")
	flag.Parse()
	if *self {
		if err := pureSelfTest(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_ = emit(map[string]any{"runtimeId": runtimeID, "version": version, "pureSelfTest": true, "desktopAccess": false})
		return
	}
	if !*observeFlag {
		fmt.Fprintln(os.Stderr, "--observe or --self-test required")
		os.Exit(2)
	}
	if err := observe(*parent, *consent); err != nil {
		fmt.Fprintln(os.Stderr, "Windows History observer unavailable")
		os.Exit(1)
	}
}
