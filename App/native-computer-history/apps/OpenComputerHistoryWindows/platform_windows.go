//go:build windows

package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var user = syscall.NewLazyDLL("user32.dll")
var kernel = syscall.NewLazyDLL("kernel32.dll")
var getForeground = user.NewProc("GetForegroundWindow")
var getWindowPID = user.NewProc("GetWindowThreadProcessId")
var nextHook = user.NewProc("CallNextHookEx")
var droppedHookActions atomic.Uint64

func activeModifiers() []string {
	var result []string
	for _, item := range []struct {
		code uintptr
		name string
	}{{17, "control"}, {18, "alt"}, {16, "shift"}, {91, "win"}} {
		state, _, _ := user.NewProc("GetAsyncKeyState").Call(item.code)
		if state&0x8000 != 0 {
			result = append(result, item.name)
		}
	}
	return result
}

func hookDropped() uint64 { return droppedHookActions.Swap(0) }

type jobBasicLimits struct {
	ProcessTime, JobTime           int64
	Flags                          uint32
	MinWorkingSet, MaxWorkingSet   uintptr
	ActiveProcessLimit             uint32
	Affinity                       uintptr
	PriorityClass, SchedulingClass uint32
}
type jobExtendedLimits struct {
	Basic                                                      jobBasicLimits
	IO                                                         [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

// Own the only non-inheritable job handle. On any exit (including Node's
// forced stop), Windows closes it and kills every outstanding UIA worker.
var lifetimeJob uintptr

func ensureJob() error {
	handle, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if handle == 0 {
		return fmt.Errorf("job create: %w", err)
	}
	limits := jobExtendedLimits{}
	limits.Basic.Flags = 0x2000
	ok, _, err := kernel.NewProc("SetInformationJobObject").Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok != 0 {
		current, _, _ := kernel.NewProc("GetCurrentProcess").Call()
		ok, _, err = kernel.NewProc("AssignProcessToJobObject").Call(handle, current)
	}
	if ok == 0 {
		kernel.NewProc("CloseHandle").Call(handle)
		return fmt.Errorf("job assign: %w", err)
	}
	lifetimeJob = handle
	return nil
}
func configureCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func watchParent(ctx context.Context, pid int, cancel context.CancelFunc) error {
	handle, _, err := kernel.NewProc("OpenProcess").Call(0x00100000, 0, uintptr(pid)) // SYNCHRONIZE; held handle cannot alias a reused PID
	if handle == 0 {
		return fmt.Errorf("parent open: %w", err)
	}
	go func() {
		defer kernel.NewProc("CloseHandle").Call(handle)
		for {
			result, _, _ := kernel.NewProc("WaitForSingleObject").Call(handle, 250)
			if result != 0x102 {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	return nil
}

type point struct{ X, Y int32 }
type mouseRecord struct {
	Point             point
	Data, Flags, Time uint32
	Extra             uintptr
}
type keyboardRecord struct {
	VK, Scan, Flags, Time uint32
	Extra                 uintptr
}
type message struct {
	HWND           uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          point
	Private        uint32
}

func foregroundIdentity() (string, uint32) {
	hwnd, _, _ := getForeground.Call()
	if hwnd == 0 {
		return "", 0
	}
	var pid uint32
	getWindowPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return strconv.FormatUint(uint64(hwnd), 10), pid
}

func installHooks(ctx context.Context, events chan<- action) error {
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		threadID, _, _ := kernel.NewProc("GetCurrentThreadId").Call()
		// Create the thread queue before another goroutine can post WM_QUIT.
		var initial message
		user.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&initial)), 0, 0, 0, 0)
		queue := func(a action) {
			if a.Window == "" || a.PID == 0 {
				return
			}
			a.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
			bindOrigin(&a)
			select {
			case events <- a:
			default:
				droppedHookActions.Add(1)
			}
		}
		mouseCallback := syscall.NewCallback(func(code, wparam, lparam uintptr) uintptr {
			if int32(code) >= 0 {
				r := (*mouseRecord)(unsafe.Pointer(lparam))
				if r.Flags&1 == 0 { // injected Computer Use actions are not human input
					window, pid := foregroundIdentity()
					a := action{Window: window, PID: pid, X: r.Point.X, Y: r.Point.Y, Count: 1}
					switch wparam {
					case 0x201:
						a.Kind = "mouse.click"
						a.Button = "left"
						queue(a)
					case 0x204:
						a.Kind = "mouse.context_menu"
						a.Button = "right"
						queue(a)
					case 0x207:
						a.Kind = "mouse.click"
						a.Button = "middle"
						queue(a)
					case 0x20a, 0x20e:
						a.Kind = "mouse.scroll"
						a.Delta = int32(int16(r.Data >> 16))
						a.ScrollAxis = "vertical"
						if wparam == 0x20e {
							a.ScrollAxis = "horizontal"
						}
						queue(a)
					}
				}
			}
			result, _, _ := nextHook.Call(0, code, wparam, lparam)
			return result
		})
		keyCallback := syscall.NewCallback(func(code, wparam, lparam uintptr) uintptr {
			if int32(code) >= 0 && (wparam == 0x100 || wparam == 0x104) {
				r := (*keyboardRecord)(unsafe.Pointer(lparam))
				if r.Flags&0x10 == 0 {
					key, safeCode := safeKey(r.VK)
					if key != "" {
						modifiers := activeModifiers()
						for _, modifier := range modifiers {
							if modifier != "shift" {
								key = "[shortcut]"
								safeCode = 0
								break
							}
						}
						window, pid := foregroundIdentity()
						queue(action{Kind: "keyboard.keydown", Window: window, PID: pid, Key: key, KeyCode: safeCode, Count: 1, Modifiers: modifiers})
					}
				}
			}
			result, _, _ := nextHook.Call(0, code, wparam, lparam)
			return result
		})
		winCallback := syscall.NewCallback(func(hook, event, hwnd, object, child, thread, at uintptr) uintptr {
			switch event {
			case 3, 0x8005, 0x8006, 0x8007, 0x8008, 0x8009, 0x800c, 0x800e, 0x8013, 0x8014:
			default:
				return 0
			}
			window, pid := foregroundIdentity()
			root, _, _ := user.NewProc("GetAncestor").Call(hwnd, 2)
			if root == 0 {
				root = hwnd
			}
			if strconv.FormatUint(uint64(root), 10) != window {
				return 0
			}
			kind := "accessibility.changed"
			if event == 3 || event == 0x8005 || (event == 0x800c && int32(object) == 0) {
				verifiedOrigin.Store(nil)
			}
			if event == 3 {
				kind = "window.changed"
			}
			if event == 0x8014 {
				kind = "selection.changed"
			}
			if event == 0x8005 {
				kind = "focus.changed"
			}
			queue(action{Kind: kind, Window: window, PID: pid})
			return 0
		})
		setHook := user.NewProc("SetWindowsHookExW")
		module, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
		mouseHook, _, mouseErr := setHook.Call(14, mouseCallback, module, 0)
		keyHook, _, keyErr := setHook.Call(13, keyCallback, module, 0)
		foregroundHook, _, _ := user.NewProc("SetWinEventHook").Call(3, 3, 0, winCallback, 0, 0, 2)
		changeHook, _, _ := user.NewProc("SetWinEventHook").Call(0x8005, 0x8014, 0, winCallback, 0, 0, 2)
		defer func() {
			if mouseHook != 0 {
				user.NewProc("UnhookWindowsHookEx").Call(mouseHook)
			}
			if keyHook != 0 {
				user.NewProc("UnhookWindowsHookEx").Call(keyHook)
			}
			if foregroundHook != 0 {
				user.NewProc("UnhookWinEvent").Call(foregroundHook)
			}
			if changeHook != 0 {
				user.NewProc("UnhookWinEvent").Call(changeHook)
			}
		}()
		if mouseHook == 0 || keyHook == 0 {
			ready <- fmt.Errorf("hooks unavailable: %v %v", mouseErr, keyErr)
		} else {
			ready <- nil
		}
		go func() { <-ctx.Done(); user.NewProc("PostThreadMessageW").Call(threadID, 0x12, 0, 0) }()
		var msg message
		for {
			result, _, _ := user.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(result) <= 0 {
				return
			}
			user.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&msg)))
			user.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&msg)))
		}
	}()
	return <-ready
}
