package tronrunner

import "time"

const (
	defaultReconnectInitial = 100 * time.Millisecond
	defaultReconnectMax     = 5 * time.Second
	handshakeTimeout        = 15 * time.Second
	pingInterval            = 30 * time.Second
	pingTimeout             = 10 * time.Second
)

// Config describes one runner.
type Config struct {
	// BaseURL is Tron's base URL (http, https, ws or wss). The runner channel's path is appended
	// from the generated RunnerChannelAddress.
	BaseURL string
	// Token is the worker API key token shown once on the Runners page.
	Token string
	// Capacity is the concurrency capacity announced to Tron (at least 1). Zero means 1.
	Capacity int
	// DisplayName is an optional human-readable name shown to the owner.
	DisplayName string
	// RunnerVersion is an optional version of the program embedding this SDK.
	RunnerVersion string
	// SecretStore persists delivery secrets. Nil uses a FileSecretStore in DefaultSecretDirectory().
	SecretStore SecretStore
	// Reconnect tunes the exponential backoff used after a connection is lost; zero values use
	// 100ms doubling to a 5s cap.
	Reconnect Backoff
	// Hooks observes the runner; every field is optional.
	Hooks Hooks
}

// Backoff is the reconnect delay: it starts at Initial, doubles after each failed attempt and stops growing at Max.
type Backoff struct {
	Initial time.Duration
	Max     time.Duration
}

// Session identifies one authenticated and announced connection.
type Session struct {
	ID string
}

// ReportRecorded is Tron's acknowledgement of a report.
type ReportRecorded struct {
	DeliveryID string
	// Late is true when the report arrived after the job's lateness threshold; it is still recorded.
	Late bool
}

// Hooks observe a runner. They are called from the runner's own goroutines, so they must return
// quickly and must not call back into Stop.
type Hooks struct {
	// OnConnected is called after every successful authenticate + announce, including reconnects.
	OnConnected func(Session)
	// OnDeliveryAccepted is called once Tron accepted a delivery and its secret is persisted, before the handler runs.
	OnDeliveryAccepted func(Delivery)
	// OnReportRecorded is called when Tron recorded a report and its stored secret was removed.
	OnReportRecorded func(ReportRecorded)
	// OnError receives the errors of work the runner does on its own: *AcceptRefusedError,
	// *ReportRejectedError, *ProtocolError, *UnroutableDeliveryError, *DeliveryAbandonedError,
	// *SecretStoreError, *UnexpectedFrameError, and a *ConnectError when a reconnect is refused
	// for good (the runner then stops; see Wait).
	OnError func(error)
}

func (b Backoff) withDefaults() Backoff {
	if b.Initial <= 0 {
		b.Initial = defaultReconnectInitial
	}
	if b.Max < b.Initial {
		b.Max = max(defaultReconnectMax, b.Initial)
	}
	return b
}
