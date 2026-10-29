package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"reflect"
	"strconv"
	"time"
)

const maxWindowID int64 = 9007199254740991

type windowKey struct {
	PID int
	ID  int64
}
type observationBinding struct {
	WindowID        int64
	ObservationID   string
	DeadlineEpochMs int64
	ExpectedAppID   string
}
type windowsFocusState struct {
	PID       int     `json:"pid"`
	WindowID  int64   `json:"windowID"`
	InputIdle float64 `json:"inputIdle"`
}

func validNativeAppID(id string) bool {
	if len(id) < 1 || len(id) > 256 {
		return false
	}
	for _, c := range id {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '!' || c == '-' {
			continue
		}
		return false
	}
	return true
}

func parseObservationBinding(args map[string]any) (observationBinding, error) {
	var binding observationBinding
	if value, present := args["_memmy_expected_app_id"]; present {
		id, ok := value.(string)
		if !ok || !validNativeAppID(id) {
			return binding, fmt.Errorf("invalid host application identity")
		}
		binding.ExpectedAppID = id
	}
	if value, present := args["window_id"]; present {
		var id int64
		switch value := value.(type) {
		case int:
			id = int64(value)
		case int64:
			id = value
		case json.Number:
			id, _ = value.Int64()
		case float64:
			if isWholeNumber(value) && value > 0 && value <= float64(maxWindowID) {
				id = int64(value)
			}
		}
		if id < 1 || id > maxWindowID {
			return binding, fmt.Errorf("window_id must be a positive safe integer")
		}
		binding.WindowID = id
	}
	if value, present := args["observation_id"]; present {
		token, ok := value.(string)
		if !ok || len(token) == 0 || len(token) > 128 {
			return binding, fmt.Errorf("observation_id must be a non-empty string of at most 128 characters")
		}
		binding.ObservationID = token
	}
	if value, present := args["_host_deadline_epoch_ms"]; present {
		var deadline int64
		switch value := value.(type) {
		case int64:
			deadline = value
		case int:
			deadline = int64(value)
		case json.Number:
			deadline, _ = value.Int64()
		case float64:
			if isWholeNumber(value) && value > 0 && value <= float64(maxWindowID) {
				deadline = int64(value)
			}
		}
		if deadline < 1 || deadline > maxWindowID {
			return binding, fmt.Errorf("invalid host operation deadline")
		}
		binding.DeadlineEpochMs = deadline
	}
	return binding, nil
}

func newObservationID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 15) | 64
	id[8] = (id[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

type coordinateRetry struct {
	observationID string
	tool          string
	endpoints     [2]image.Point
}

func coordinateEndpoints(points []image.Point) [2]image.Point {
	return [2]image.Point{points[0], points[len(points)-1]}
}

func (retry *coordinateRetry) matches(observationID, tool string, points []image.Point) bool {
	near := func(a, b image.Point) bool {
		return math.Abs(float64(a.X-b.X)) <= 16 && math.Abs(float64(a.Y-b.Y)) <= 16
	}
	endpoints := coordinateEndpoints(points)
	return retry != nil && observationID != "" && retry.observationID == observationID && retry.tool == tool &&
		near(retry.endpoints[0], endpoints[0]) && near(retry.endpoints[1], endpoints[1])
}

func observedElementInSnapshot(snapshot *appSnapshot, observed *elementRecord) *elementRecord {
	if observed == nil || len(observed.RuntimeID) == 0 {
		return nil
	}
	// Repeated records with one runtime ID are the same UIA object.
	var found *elementRecord
	for index := range snapshot.Elements {
		candidate := &snapshot.Elements[index]
		if reflect.DeepEqual(candidate.RuntimeID, observed.RuntimeID) && (found == nil || candidate.Index < found.Index) {
			found = candidate
		}
	}
	return found
}

func noActionState(snapshot *appSnapshot, reason string) toolCallResult {
	snapshot.ObservationNote = "State changed; no action was dispatched. " + reason + " Use this fresh observation before acting again."
	result := snapshot.result()
	meta := result.Meta["memmyComputerUse"].(map[string]any)
	meta["stateChanged"] = true
	meta["noActionDispatched"] = true
	return result
}

// Only a change that would send the input to a different target withholds it.
// Live apps constantly change banners, popups, focus and document text; the
// action result shows that state, so it must not prevent the action itself.
func (s *service) prepareAction(app string, request psRequest) (*psRequest, toolCallResult) {
	cached := s.currentSnapshot(app)
	if cached == nil || cached.TargetWindowID < 1 || cached.App.PID < 1 {
		return nil, textResult("No bound window observation is available. Run get_app_state before action tools.", true)
	}
	stateRequest := cached.renderRequest
	stateRequest.Tool, stateRequest.App = "get_app_state", app
	stateRequest.WindowID, stateRequest.ExpectedPID = cached.TargetWindowID, cached.App.PID
	fresh, result := s.refreshSnapshot(app, stateRequest)
	if result.IsError {
		return nil, result
	}
	confirmed := s.confirmedRetry
	s.confirmedRetry = nil
	if s.binding.ObservationID != "" && s.binding.ObservationID != cached.ObservationID {
		return nil, noActionState(fresh, "The action referred to an observation that is no longer retained.")
	}
	request.WindowID, request.ExpectedPID = fresh.TargetWindowID, fresh.App.PID
	request.ObservedKeyboardReceiverID, request.ObservedKeyboardReceiverRuntimeID = fresh.KeyboardReceiverID, fresh.KeyboardReceiverRuntimeID
	request.WindowBounds = fresh.WindowBounds
	request.RelatedWindowIDs = append([]int64{}, fresh.RelatedWindowIDs...)
	request.ObservedCaptureGroupProof = fresh.CaptureGroupProof
	request.TextLimit, request.MaxTreeNodes, request.MaxTreeDepth = stateRequest.TextLimit, stateRequest.MaxTreeNodes, stateRequest.MaxTreeDepth
	request.observed = fresh
	if request.Element != nil {
		element := observedElementInSnapshot(fresh, request.Element)
		if element == nil || element.ControlType != request.Element.ControlType {
			return nil, noActionState(fresh, "The selected element is no longer present.")
		}
		request.Element = element
		return &request, toolCallResult{}
	}
	if request.Tool != "click" && request.Tool != "scroll" && request.Tool != "drag" {
		return &request, toolCallResult{}
	}
	before, after := cached.ScreenshotPNGBase64, fresh.ScreenshotPNGBase64
	if !cached.ScreenshotIsolated || !fresh.ScreenshotIsolated || before == "" || after == "" {
		return nil, noActionState(fresh, "The fallback window image has no verified native coordinate origin. Use an exact UI Automation element_index instead.")
	}
	previous, err := decodeObservationPNG(before)
	if err != nil {
		return nil, noActionState(fresh, "A reliable observed window image is unavailable.")
	}
	current, err := decodeObservationPNG(after)
	if err != nil || previous.Bounds() != current.Bounds() {
		return nil, noActionState(fresh, "The window image is unavailable or the window was resized.")
	}
	points, err := coordinatePoints(request, previous.Bounds().Dx(), previous.Bounds().Dy())
	if err != nil {
		return nil, noActionState(fresh, err.Error())
	}
	for _, point := range points {
		if stableImagePatch(previous, current, point.X, point.Y) {
			continue
		}
		// After one withheld frame, choosing the same target again from the
		// returned state confirms it; an animated target must stay reachable.
		if confirmed.matches(s.binding.ObservationID, request.Tool, points) {
			break
		}
		s.confirmedRetry = &coordinateRetry{observationID: fresh.ObservationID, tool: request.Tool, endpoints: coordinateEndpoints(points)}
		return nil, noActionState(fresh, "Something new now covers the coordinate target. Check this fresh state; if the same target is still intended, send it again with this observation_id.")
	}
	bounds := fresh.WindowBounds
	if bounds == nil || !finitePositive(bounds.Width) || !finitePositive(bounds.Height) {
		return nil, noActionState(fresh, "The native window dimensions are unavailable.")
	}
	if math.Round(bounds.Width) != float64(previous.Bounds().Dx()) || math.Round(bounds.Height) != float64(previous.Bounds().Dy()) {
		return nil, noActionState(fresh, "The native image dimensions do not match the physical window bounds.")
	}
	return &request, toolCallResult{}
}

func (request psRequest) checkDeadline() error {
	if request.ctx != nil && request.ctx.Err() != nil {
		return fmt.Errorf("Windows operation was cancelled")
	}
	if request.DeadlineEpochMs > 0 && time.Now().UnixMilli() >= request.DeadlineEpochMs {
		return fmt.Errorf("Windows operation deadline expired")
	}
	return nil
}

func ptrNumber(value float64) *float64 { return &value }
func finitePositive(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0
}

func decodeObservationPNG(encoded string) (image.Image, error) {
	if len(encoded) == 0 || len(encoded) > 64*1024*1024 {
		return nil, fmt.Errorf("invalid image size")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 8192 || config.Height > 8192 || int64(config.Width)*int64(config.Height) > 32*1024*1024 {
		return nil, fmt.Errorf("invalid image dimensions")
	}
	return png.Decode(bytes.NewReader(data))
}

func coordinatePoints(request psRequest, width, height int) ([]image.Point, error) {
	point := func(x, y *float64) (image.Point, error) {
		if x == nil || y == nil || math.IsNaN(*x) || math.IsNaN(*y) || math.IsInf(*x, 0) || math.IsInf(*y, 0) || *x < 0 || *y < 0 || *x >= float64(width) || *y >= float64(height) {
			return image.Point{}, fmt.Errorf("Coordinates are outside the observed screenshot.")
		}
		return image.Pt(int(*x), int(*y)), nil
	}
	if request.Tool != "drag" {
		p, err := point(request.X, request.Y)
		return []image.Point{p}, err
	}
	from, err := point(request.FromX, request.FromY)
	if err != nil {
		return nil, err
	}
	to, err := point(request.ToX, request.ToY)
	if err != nil {
		return nil, err
	}
	steps := int(math.Ceil(math.Hypot(float64(to.X-from.X), float64(to.Y-from.Y)) / 64))
	if steps < 1 {
		steps = 1
	}
	if steps > 256 {
		return nil, fmt.Errorf("The drag path is too long to verify.")
	}
	points := make([]image.Point, 0, steps+1)
	for index := 0; index <= steps; index++ {
		fraction := float64(index) / float64(steps)
		points = append(points, image.Pt(int(float64(from.X)+fraction*float64(to.X-from.X)), int(float64(from.Y)+fraction*float64(to.Y-from.Y))))
	}
	return points, nil
}

func stableImagePatch(before, after image.Image, x, y int) bool {
	area := image.Rect(x-32, y-32, x+33, y+33).Intersect(before.Bounds())
	var changed, total int
	var distance int64
	for py := area.Min.Y; py < area.Max.Y; py++ {
		for px := area.Min.X; px < area.Max.X; px++ {
			r1, g1, b1, _ := before.At(px, py).RGBA()
			r2, g2, b2, _ := after.At(px, py).RGBA()
			diff := func(a, b uint32) int64 {
				value := int64(a>>8) - int64(b>>8)
				if value < 0 {
					return -value
				}
				return value
			}
			d := diff(r1, r2) + diff(g1, g2) + diff(b1, b2)
			if d > 60 {
				changed++
			}
			distance += d
			total++
		}
	}
	return total > 0 && changed*100 <= total*10 && distance <= int64(total)*36
}

func parseRevealWindowArgs(args []string) (psRequest, error) {
	request := psRequest{Tool: "reveal_window"}
	if len(args) != 4 {
		return request, fmt.Errorf("reveal-window requires --pid N --window-id H")
	}
	seen := map[string]bool{}
	for index := 0; index < 4; index += 2 {
		key := args[index]
		if seen[key] {
			return request, fmt.Errorf("duplicate reveal-window option")
		}
		seen[key] = true
		value, err := strconv.ParseInt(args[index+1], 10, 64)
		if err != nil || value < 1 {
			return request, fmt.Errorf("invalid reveal-window identifier")
		}
		switch key {
		case "--pid":
			if value > 0x7fffffff {
				return request, fmt.Errorf("invalid process ID")
			}
			request.ExpectedPID = int(value)
			request.App = strconv.FormatInt(value, 10)
		case "--window-id":
			if value > maxWindowID {
				return request, fmt.Errorf("invalid window ID")
			}
			request.WindowID = value
		default:
			return request, fmt.Errorf("unknown reveal-window option")
		}
	}
	if request.ExpectedPID == 0 || request.WindowID == 0 {
		return request, fmt.Errorf("reveal-window requires --pid and --window-id")
	}
	return request, nil
}
