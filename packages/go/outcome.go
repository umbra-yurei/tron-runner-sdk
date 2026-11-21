package tronrunner

import (
	"context"
	"time"

	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

// Outcome is how a handler finished: exactly one of Ok or Err, each carrying a message.
type Outcome struct {
	message string
	failed  bool
}

// Ok is a successful outcome carrying a message Tron records with the run.
func Ok(message string) Outcome { return Outcome{message: message} }

// Err is a failed outcome carrying a message Tron records with the run.
func Err(message string) Outcome { return Outcome{message: message, failed: true} }

// Message is the text the outcome carries.
func (o Outcome) Message() string { return o.message }

// Failed reports whether this is an Err outcome.
func (o Outcome) Failed() bool { return o.failed }

func (o Outcome) wire() generated.RunOutcome {
	message := o.message
	if o.failed {
		return generated.RunOutcome{Err: &message}
	}
	return generated.RunOutcome{Ok: &message}
}

// Delivery is one run of a job Tron pushed to this runner.
type Delivery struct {
	DeliveryID string
	RunID      string
	JobID      string
	JobName    string
	// ScheduledFor is when the run was due.
	ScheduledFor time.Time
	// AcceptDeadline is when Tron stops accepting the delivery; the SDK accepts immediately.
	AcceptDeadline time.Time
}

// Handler runs a delivery. The context is cancelled when the runner is forced to close.
// A panic is recovered and reported as an Err outcome.
type Handler func(ctx context.Context, delivery Delivery) Outcome
