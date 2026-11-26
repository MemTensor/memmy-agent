package main

import "time"

// Gaps describe observation intervals, never the lifetime of the process.
// Compaction may conservatively merge old intervals, but cannot taint a later
// healthy interval. Persistent faults remain open until explicit recovery.
type coverageGap struct{ from, through time.Time }
type coverageTracker struct {
	closed []coverageGap
	open   map[string]time.Time
}

func (c *coverageTracker) begin(reason string, at time.Time) {
	if c.open == nil {
		c.open = make(map[string]time.Time)
	}
	if previous, ok := c.open[reason]; !ok || at.Before(previous) {
		c.open[reason] = at
	}
}
func (c *coverageTracker) recover(reason string, at time.Time) {
	if from, ok := c.open[reason]; ok {
		delete(c.open, reason)
		c.missing(from, at)
	}
}
func (c *coverageTracker) missing(from, through time.Time) {
	if through.Before(from) {
		through = from
	}
	c.closed = append(c.closed, coverageGap{from, through})
	if len(c.closed) > 512 {
		a, b := c.closed[0], c.closed[1]
		if b.from.Before(a.from) {
			a.from = b.from
		}
		if b.through.After(a.through) {
			a.through = b.through
		}
		c.closed[1] = a
		c.closed = c.closed[1:]
	}
}
func (c *coverageTracker) complete(from, through time.Time) bool {
	for _, gap := range c.closed {
		if !gap.through.Before(from) && !gap.from.After(through) {
			return false
		}
	}
	for _, start := range c.open {
		if !start.After(through) {
			return false
		}
	}
	return true
}
func actionTime(a action, fallback time.Time) time.Time {
	if at, err := time.Parse(time.RFC3339Nano, a.Timestamp); err == nil && !at.After(fallback) {
		return at
	}
	return fallback
}
func (s *scheduler) pendingThrough(through time.Time) bool {
	if s.typing != nil && !actionTime(*s.typing, s.typingAt).After(through) {
		return true
	}
	for _, a := range s.pending {
		if !actionTime(a, time.Now()).After(through) {
			return true
		}
	}
	return false
}
