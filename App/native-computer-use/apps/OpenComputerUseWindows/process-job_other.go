//go:build !windows

package main

import "os/exec"

func ensureNativeProcessJob() error        { return nil }
func configureNativeCommand(cmd *exec.Cmd) {}
