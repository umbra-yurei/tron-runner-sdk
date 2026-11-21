// Command adapter exposes the Go SDK to the shared conformance suite (conformance/README.md).
// It reads one generated adapter command per line on stdin and writes one generated adapter
// event per line on stdout; every message is encoded and decoded with the generated bindings.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"time"

	tronrunner "github.com/umbra-yurei/tron-runner-sdk/packages/go"
	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

const (
	stopTimeout      = 30 * time.Second
	reportTimeout    = 60 * time.Second
	stdinBufferBytes = 1 << 20
	tamperedSuffix   = "-tampered"
	exitCodeFailure  = 1
	exitCodeProtocol = 2
	startNotReceived = "no start command was received"
)

type marshaler interface{ Marshal() ([]byte, error) }

var (
	outMu sync.Mutex
	out   = bufio.NewWriter(os.Stdout)
)

func emit(event marshaler) {
	data, err := event.Marshal()
	if err != nil {
		fmt.Fprintln(os.Stderr, "encode event:", err)
		os.Exit(exitCodeFailure)
	}
	outMu.Lock()
	defer outMu.Unlock()
	out.Write(data)
	out.WriteByte('\n')
	out.Flush()
}

func emitError(err error) {
	emit(&generated.AdapterErrorEvent{Message: err.Error(), Type: generated.TypeError})
}

// tamperedStore returns a wrong secret from every load; retainingStore never removes. Both are
// written through the SDK's pluggable store interface, wrapping the file default.
type tamperedStore struct{ tronrunner.SecretStore }

func (s tamperedStore) Load(deliveryID string) (string, bool, error) {
	secret, found, err := s.SecretStore.Load(deliveryID)
	if err != nil || !found {
		return secret, found, err
	}
	return secret + tamperedSuffix, true, nil
}

type retainingStore struct{ tronrunner.SecretStore }

func (retainingStore) Remove(string) error { return nil }

func secretStore(config generated.SecretStoreConfig) (tronrunner.SecretStore, error) {
	base, err := tronrunner.NewFileSecretStore(config.Directory)
	if err != nil {
		return nil, err
	}
	switch config.Kind {
	case generated.File:
		return base, nil
	case generated.Tampered:
		return tamperedStore{base}, nil
	case generated.Retaining:
		return retainingStore{base}, nil
	}
	return nil, fmt.Errorf("unknown secret store kind %q", config.Kind)
}

// baseURL drops the path of the runner URL the harness passes: the SDK appends the channel
// address from its own generated constant.
func baseURL(runnerURL string) (string, error) {
	parsed, err := url.Parse(runnerURL)
	if err != nil {
		return "", err
	}
	parsed.Path = ""
	return parsed.String(), nil
}

func scriptedHandler(script generated.HandlerScript) tronrunner.Handler {
	return func(ctx context.Context, delivery tronrunner.Delivery) tronrunner.Outcome {
		emit(&generated.HandlerInvokedEvent{
			DeliveryID: delivery.DeliveryID,
			HandlerKey: script.HandlerKey,
			JobID:      delivery.JobID,
			JobName:    delivery.JobName,
			RunID:      delivery.RunID,
			Type:       generated.TypeHandlerInvoked,
		})
		select {
		case <-time.After(time.Duration(script.DelayMS) * time.Millisecond):
		case <-ctx.Done():
		}
		if script.Outcome == generated.ReplyErr {
			return tronrunner.Err(script.Message)
		}
		return tronrunner.Ok(script.Message)
	}
}

var hooks = tronrunner.Hooks{
	OnConnected: func(session tronrunner.Session) {
		emit(&generated.ConnectedEvent{SessionID: session.ID, Type: generated.TypeConnected})
	},
	OnDeliveryAccepted: func(delivery tronrunner.Delivery) {
		emit(&generated.DeliveryAcceptedEvent{DeliveryID: delivery.DeliveryID, Type: generated.TypeDeliveryAccepted})
	},
	OnReportRecorded: func(recorded tronrunner.ReportRecorded) {
		emit(&generated.ReportRecordedEvent{DeliveryID: recorded.DeliveryID, Late: recorded.Late, Type: generated.TypeReportRecorded})
	},
	OnError: emitTyped,
}

// emitTyped maps the SDK's typed errors to the adapter events that name them; anything else is an `error` event.
func emitTyped(err error) {
	var refused *tronrunner.AcceptRefusedError
	var rejected *tronrunner.ReportRejectedError
	switch {
	case errors.As(err, &refused):
		emit(&generated.AcceptRefusedEvent{DeliveryID: refused.DeliveryID, Reason: refused.Reason, Type: generated.TypeAcceptRefused})
	case errors.As(err, &rejected):
		emit(&generated.ReportRejectedEvent{DeliveryID: rejected.DeliveryID, Reason: rejected.Reason, Type: generated.TypeReportRejected})
	default:
		emitError(err)
	}
}

func start(command generated.StartCommand) (*tronrunner.Runner, error) {
	store, err := secretStore(command.SecretStore)
	if err != nil {
		return nil, err
	}
	base, err := baseURL(command.TRONURL)
	if err != nil {
		return nil, err
	}
	config := tronrunner.Config{
		BaseURL:     base,
		Token:       command.Token,
		Capacity:    int(command.ConcurrencyCapacity),
		SecretStore: store,
		Hooks:       hooks,
	}
	if command.DisplayName != nil {
		config.DisplayName = *command.DisplayName
	}
	if command.RunnerVersion != nil {
		config.RunnerVersion = *command.RunnerVersion
	}
	runner, err := tronrunner.New(config)
	if err != nil {
		return nil, err
	}
	for _, script := range command.Handlers {
		if err := runner.Handle(script.HandlerKey, scriptedHandler(script)); err != nil {
			return nil, err
		}
	}
	return runner, nil
}

func outcomeOf(outcome generated.RunOutcome) (tronrunner.Outcome, error) {
	switch {
	case outcome.Ok != nil:
		return tronrunner.Ok(*outcome.Ok), nil
	case outcome.Err != nil:
		return tronrunner.Err(*outcome.Err), nil
	}
	return tronrunner.Outcome{}, errors.New("outcome carries neither ok nor err")
}

func connectFailure(err error) {
	var connectErr *tronrunner.ConnectError
	if errors.As(err, &connectErr) {
		emit(&generated.ConnectFailedEvent{Reason: connectErr.Reason, Type: generated.TypeConnectFailed})
		return
	}
	emitError(err)
}

func main() {
	protocolVersion := generated.RunnerProtocolVersion(generated.ProtocolVersion)
	emit(&generated.ReadyEvent{ProtocolVersion: protocolVersion, SDKVersion: tronrunner.SDKVersion, Type: generated.TypeReady})

	var runner *tronrunner.Runner
	requireRunner := func() *tronrunner.Runner {
		if runner == nil {
			emitError(errors.New(startNotReceived))
		}
		return runner
	}

	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 0, stdinBufferBytes), stdinBufferBytes)
	for lines.Scan() {
		line := lines.Bytes()
		if len(line) == 0 {
			continue
		}
		tag, err := generated.UnmarshalAdapterCommandTag(line)
		if err != nil {
			emitError(err)
			continue
		}
		switch tag.Type {
		case generated.AdapterCommandKindStart:
			command, err := generated.UnmarshalStartCommand(line)
			if err != nil {
				emitError(err)
				continue
			}
			if runner, err = start(command); err != nil {
				emitError(err)
				continue
			}
			if err := runner.Connect(context.Background()); err != nil {
				connectFailure(err)
			}
		case generated.AdapterCommandKindReportPending:
			command, err := generated.UnmarshalReportPendingCommand(line)
			if err != nil {
				emitError(err)
				continue
			}
			if requireRunner() == nil {
				continue
			}
			outcome, err := outcomeOf(command.Outcome)
			if err != nil {
				emitError(err)
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), reportTimeout)
			err = runner.ReportPending(ctx, command.DeliveryID, outcome)
			cancel()
			if err != nil {
				emitTyped(err)
			}
		case generated.AdapterCommandKindListPending:
			if requireRunner() == nil {
				continue
			}
			pending, err := runner.Pending()
			if err != nil {
				emitError(err)
				continue
			}
			emit(&generated.PendingEvent{DeliveryIDS: pending, Type: generated.TypePending})
		case generated.AdapterCommandKindStop:
			if requireRunner() == nil {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), stopTimeout)
			err := runner.Stop(ctx)
			cancel()
			if err != nil {
				emitError(err)
				os.Exit(exitCodeFailure)
			}
			emit(&generated.StoppedEvent{Type: generated.TypeStopped})
			os.Exit(0)
		default:
			emitError(fmt.Errorf("unknown command %q", tag.Type))
		}
	}
	if err := lines.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "read commands:", err)
		os.Exit(exitCodeProtocol)
	}
}
