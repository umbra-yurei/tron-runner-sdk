package tronrunner

import "sync"

// tracker counts work the runner owes an answer for: from a `work` frame (or an explicit report)
// until Tron's final answer. Once draining it refuses new work and reports when the count reaches zero.
type tracker struct {
	mu       sync.Mutex
	count    int
	draining bool
	closed   bool
	idle     chan struct{}
}

func newTracker() *tracker { return &tracker{idle: make(chan struct{})} }

// begin records one more piece of owed work; false when draining.
func (t *tracker) begin() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.draining {
		return false
	}
	t.count++
	return true
}

func (t *tracker) end() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.count--
	t.closeIfIdle()
}

// drain stops accepting new work and returns a channel closed once everything owed has been answered.
func (t *tracker) drain() <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.draining = true
	t.closeIfIdle()
	return t.idle
}

func (t *tracker) isDraining() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.draining
}

func (t *tracker) closeIfIdle() {
	if t.draining && t.count == 0 && !t.closed {
		t.closed = true
		close(t.idle)
	}
}
