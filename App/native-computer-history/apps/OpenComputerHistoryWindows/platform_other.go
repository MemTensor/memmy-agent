//go:build !windows

package main

import (
	"context"
	"errors"
	"os/exec"
)

func ensureJob() error               { return errors.New("Windows required") }
func configureCommand(cmd *exec.Cmd) {}
func hookDropped() uint64            { return 0 }
func watchParent(ctx context.Context, pid int, cancel context.CancelFunc) error {
	return errors.New("Windows required")
}
func installHooks(ctx context.Context, events chan<- action) error {
	return errors.New("Windows required")
}
