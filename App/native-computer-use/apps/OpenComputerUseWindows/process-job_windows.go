//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

// Join a private, non-inheritable job before spawning PowerShell. Its children
// inherit membership, so terminating this helper also terminates native workers.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
var nativeJob struct {
	once   sync.Once
	handle uintptr
	err    error
}

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

func ensureNativeProcessJob() error {
	nativeJob.once.Do(func() {
		kernel := syscall.NewLazyDLL("kernel32.dll")
		handle, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
		if handle == 0 {
			nativeJob.err = fmt.Errorf("cannot create native cancellation job: %w", err)
			return
		}
		limits := jobExtendedLimits{}
		limits.Basic.Flags = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		ok, _, err := kernel.NewProc("SetInformationJobObject").Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
		if ok != 0 {
			current, _, _ := kernel.NewProc("GetCurrentProcess").Call()
			ok, _, err = kernel.NewProc("AssignProcessToJobObject").Call(handle, current)
		}
		if ok == 0 {
			kernel.NewProc("CloseHandle").Call(handle)
			nativeJob.err = fmt.Errorf("cannot establish native cancellation job: %w", err)
			return
		}
		// Keep the only handle for this process's lifetime. It is not inherited.
		nativeJob.handle = handle
	})
	return nativeJob.err
}

func configureNativeCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
