package main

import (
	"testing"
	"time"
)

func TestCoverageGapsRemainLocalToTheRecordedInterval(t *testing.T) {
	start := time.Unix(100, 0)
	c := coverageTracker{}
	c.begin("observer", start)
	c.recover("observer", start.Add(time.Second))
	c.missing(start.Add(2*time.Second), start.Add(3*time.Second))
	if c.complete(start, start.Add(4*time.Second)) {
		t.Fatal("damaged interval lost its gap")
	}
	if !c.complete(start.Add(4*time.Second), start.Add(5*time.Second)) {
		t.Fatal("historic truncation tainted the healthy fragment")
	}
	c.begin("observer", start.Add(6*time.Second))
	if c.complete(start.Add(7*time.Second), start.Add(8*time.Second)) {
		t.Fatal("ongoing loss was omitted")
	}
	c.recover("observer", start.Add(9*time.Second))
	if !c.complete(start.Add(10*time.Second), start.Add(11*time.Second)) {
		t.Fatal("recovery did not permit a later healthy fragment")
	}
	if c.complete(start.Add(7*time.Second), start.Add(8*time.Second)) {
		t.Fatal("recovery erased earlier missing evidence")
	}
}
func TestCoverageCompactionDoesNotTaintFutureOrStoppedIntervals(t *testing.T) {
	start := time.Unix(100, 0)
	c := coverageTracker{}
	for i := 0; i < 1500; i++ {
		c.missing(start.Add(time.Duration(i)*time.Millisecond), start.Add(time.Duration(i)*time.Millisecond))
	}
	if len(c.closed) > 512 {
		t.Fatal("unbounded gap history")
	}
	if !c.complete(start.Add(2*time.Second), start.Add(3*time.Second)) {
		t.Fatal("compaction poisoned future healthy evidence")
	}
	c.missing(start.Add(4*time.Second), start.Add(5*time.Second))
	if !c.complete(start.Add(2*time.Second), start.Add(3*time.Second)) {
		t.Fatal("post-stop loss changed an earlier healthy fragment")
	}
}
func TestBarrierDoesNotWaitForActionsAfterItsCutoff(t *testing.T) {
	start := time.Now().Add(-time.Minute)
	s := scheduler{}
	s.add(action{Kind: "mouse.click", Window: "1", PID: 1, Timestamp: start.Format(time.RFC3339Nano)}, start)
	s.add(action{Kind: "mouse.click", Window: "1", PID: 1, Timestamp: start.Add(2 * time.Second).Format(time.RFC3339Nano)}, start.Add(2*time.Second))
	if !s.pendingThrough(start.Add(time.Second)) {
		t.Fatal("pre-cutoff action omitted")
	}
	s.pending = s.pending[1:]
	if s.pendingThrough(start.Add(time.Second)) {
		t.Fatal("post-stop input delayed the barrier")
	}
}
