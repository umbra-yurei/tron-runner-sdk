package tronrunner

import (
	"errors"
	"fmt"

	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

var (
	// ErrClosed is returned when the runner was stopped (or its context ended) before an operation finished.
	ErrClosed = errors.New("tronrunner: runner is closed")
	// ErrAlreadyStarted is returned by Connect and Handle once the runner has connected.
	ErrAlreadyStarted = errors.New("tronrunner: runner already started")
	// ErrNoHandlers is returned by Connect when no handler was registered: there would be nothing to announce.
	ErrNoHandlers = errors.New("tronrunner: no handler registered")
	// ErrNotConnected is returned by operations that need a runner that has connected.
	ErrNotConnected = errors.New("tronrunner: runner has not connected")
	// ErrNoStoredSecret is returned by ReportPending when the secret store holds nothing for the delivery.
	ErrNoStoredSecret = errors.New("tronrunner: no stored secret for the delivery")
	// ErrReportInProgress is returned when a report for the same delivery is already awaiting Tron's answer.
	ErrReportInProgress = errors.New("tronrunner: a report for the delivery is already in progress")
	// ErrInvalidDeliveryID is returned by a secret store given an identifier it will not use as a key.
	ErrInvalidDeliveryID = errors.New("tronrunner: invalid delivery id")
)

// ConnectError is a typed connection failure. Reason is the generated closed enum.
// An authentication or announcement failure is never retried; an unreachable Tron is
// retried only after the first successful connection.
type ConnectError struct {
	Reason generated.ConnectFailure
	// Violation is Tron's reason when Reason is announcement_rejected.
	Violation *generated.ProtocolViolation
	// Cause is the underlying transport or protocol error, if any.
	Cause error
}

func (e *ConnectError) Error() string {
	if e.Violation != nil {
		return fmt.Sprintf("tronrunner: connect failed: %s (%s)", e.Reason, *e.Violation)
	}
	if e.Cause != nil {
		return fmt.Sprintf("tronrunner: connect failed: %s: %v", e.Reason, e.Cause)
	}
	return fmt.Sprintf("tronrunner: connect failed: %s", e.Reason)
}

func (e *ConnectError) Unwrap() error { return e.Cause }

// AcceptRefusedError means Tron refused an accept; the handler was not run.
type AcceptRefusedError struct {
	DeliveryID string
	Reason     generated.AcceptRefusal
}

func (e *AcceptRefusedError) Error() string {
	return fmt.Sprintf("tronrunner: accept of delivery %s refused: %s", e.DeliveryID, e.Reason)
}

// ReportRejectedError means Tron rejected a report. The SDK does not retry it and keeps the stored secret.
type ReportRejectedError struct {
	DeliveryID string
	Reason     generated.ReportRejection
}

func (e *ReportRejectedError) Error() string {
	return fmt.Sprintf("tronrunner: report of delivery %s rejected: %s", e.DeliveryID, e.Reason)
}

// ProtocolError is a protocol_error Tron sent on an established connection.
type ProtocolError struct {
	Reason generated.ProtocolViolation
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("tronrunner: protocol error: %s", e.Reason)
}

// UnknownHandlerError means a delivery arrived for a handler key this runner has no handler
// registered for; the delivery is not accepted.
type UnknownHandlerError struct {
	DeliveryID string
	HandlerKey string
}

func (e *UnknownHandlerError) Error() string {
	return fmt.Sprintf("tronrunner: delivery %s is for handler key %q, which has no registered handler", e.DeliveryID, e.HandlerKey)
}

// DeliveryAbandonedError means the connection was lost after a delivery was accepted-pending
// but before Tron answered; the delivery belongs to a dead session and its handler was not run.
type DeliveryAbandonedError struct {
	DeliveryID string
}

func (e *DeliveryAbandonedError) Error() string {
	return fmt.Sprintf("tronrunner: connection lost before delivery %s was accepted", e.DeliveryID)
}

// SecretStoreError is a failure of the secret store while handling a delivery.
type SecretStoreError struct {
	DeliveryID string
	Err        error
}

func (e *SecretStoreError) Error() string {
	return fmt.Sprintf("tronrunner: secret store failed for delivery %s: %v", e.DeliveryID, e.Err)
}

func (e *SecretStoreError) Unwrap() error { return e.Err }

// UnexpectedFrameError is a frame Tron sent that this SDK cannot act on: an unknown kind, one
// that is invalid in the current state, an answer nobody was waiting for, or undecodable.
type UnexpectedFrameError struct {
	Kind generated.ServerFrameKind
	Err  error
}

func (e *UnexpectedFrameError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("tronrunner: unexpected %q frame: %v", e.Kind, e.Err)
	}
	return fmt.Sprintf("tronrunner: unexpected %q frame", e.Kind)
}

func (e *UnexpectedFrameError) Unwrap() error { return e.Err }
