package tronrunner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

// newFakeTron starts an httptest server with a fake Tron endpoint. Errors the fake hits while
// serving fail the test when it ends, so the assertions made inside the fake are not lost.
func newFakeTron(t *testing.T, accept func(context.Context, *websocket.Conn) error) *httptest.Server {
	var mu sync.Mutex
	var serveErrs []error
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != generated.RunnerChannelAddress {
			http.NotFound(w, r)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close(websocket.StatusInternalError, "")
		err = accept(r.Context(), ws)
		if err != nil && !errors.Is(err, context.Canceled) && websocket.CloseStatus(err) == -1 {
			mu.Lock()
			serveErrs = append(serveErrs, err)
			mu.Unlock()
		}
	}))
	t.Cleanup(func() {
		server.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, err := range serveErrs {
			t.Errorf("fake server error: %v", err)
		}
	})
	return server
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// fakeRunnerHelper is a helper that performs the runner handshake and allows tests to interact with the connection.
type fakeRunnerHelper struct {
	ws        *websocket.Conn
	sessionID string
}

// newFakeRunnerHelper accepts a connection, performs authentication and announcement, and returns a helper.
func newFakeRunnerHelper(ctx context.Context, ws *websocket.Conn, options fakeRunnerOptions) (*fakeRunnerHelper, error) {
	h := &fakeRunnerHelper{ws: ws}

	// Read authenticate frame
	_, err := readAuthenticateFrame(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("read authenticate: %w", err)
	}

	if options.FailAuth {
		authFailed := generated.AuthenticationFailedFrame{Type: generated.TypeAuthenticationFailed}
		if err := sendFrame(ctx, ws, &authFailed); err != nil {
			return nil, fmt.Errorf("send authentication_failed: %w", err)
		}
		return h, nil
	}

	// Send authenticated
	sessionID := "session-" + (options.SessionID)
	if sessionID == "session-" {
		sessionID = "session-123"
	}
	h.sessionID = sessionID
	authenticated := generated.AuthenticatedFrame{
		SessionID: sessionID,
		Type:      generated.TypeAuthenticated,
	}
	if err := sendFrame(ctx, ws, &authenticated); err != nil {
		return nil, fmt.Errorf("send authenticated: %w", err)
	}

	// Read announce frame
	announce, err := readAnnounceFrame(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("read announce: %w", err)
	}
	h.ws = ws

	if options.RejectAnnouncement {
		violation := generated.InvalidAnnouncement
		protocolErr := generated.ProtocolErrorFrame{
			Reason: violation,
			Type:   generated.TypeProtocolError,
		}
		if err := sendFrame(ctx, ws, &protocolErr); err != nil {
			return nil, fmt.Errorf("send protocol_error: %w", err)
		}
		return h, nil
	}

	// Validate announcement
	if announce.Announcement.ProtocolVersion == nil || *announce.Announcement.ProtocolVersion != generated.V1 {
		return nil, fmt.Errorf("unexpected protocol version")
	}
	if announce.Announcement.SDKVersion == nil || *announce.Announcement.SDKVersion != SDKVersion {
		return nil, fmt.Errorf("unexpected SDK version: got %v", announce.Announcement.SDKVersion)
	}

	keys := announce.Announcement.HandlerKeys
	sort.Strings(keys)
	if len(keys) != len(options.ExpectHandlerKeys) {
		return nil, fmt.Errorf("unexpected handler keys: got %v, want %v", keys, options.ExpectHandlerKeys)
	}
	expectedKeys := make([]string, len(options.ExpectHandlerKeys))
	copy(expectedKeys, options.ExpectHandlerKeys)
	sort.Strings(expectedKeys)
	for i, k := range keys {
		if k != expectedKeys[i] {
			return nil, fmt.Errorf("handler keys mismatch at %d: got %q, want %q", i, k, expectedKeys[i])
		}
	}

	if got := announce.Announcement.ConcurrencyCapacity; got == nil || *got != int64(options.ExpectCapacity) {
		return nil, fmt.Errorf("unexpected capacity: got %v, want %d", got, options.ExpectCapacity)
	}

	// Send announced
	announced := generated.AnnouncedFrame{Type: generated.TypeAnnounced}
	if err := sendFrame(ctx, ws, &announced); err != nil {
		return nil, fmt.Errorf("send announced: %w", err)
	}

	return h, nil
}

type fakeRunnerOptions struct {
	FailAuth              bool
	RejectAnnouncement    bool
	SessionID             string
	ExpectHandlerKeys     []string
	ExpectCapacity        int
	ExpectProtocolVersion string
}

func readAuthenticateFrame(ctx context.Context, ws *websocket.Conn) (*generated.AuthenticateFrame, error) {
	messageType, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("binary message")
	}
	tag, err := generated.UnmarshalRunnerFrameTag(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal tag: %w", err)
	}
	if tag.Type != generated.RunnerFrameKindAuthenticate {
		return nil, fmt.Errorf("expected authenticate, got %s", tag.Type)
	}
	frame, err := generated.UnmarshalAuthenticateFrame(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal authenticate: %w", err)
	}
	return &frame, nil
}

func readAnnounceFrame(ctx context.Context, ws *websocket.Conn) (*generated.AnnounceFrame, error) {
	messageType, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("binary message")
	}
	tag, err := generated.UnmarshalRunnerFrameTag(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal tag: %w", err)
	}
	if tag.Type != generated.RunnerFrameKindAnnounce {
		return nil, fmt.Errorf("expected announce, got %s", tag.Type)
	}
	frame, err := generated.UnmarshalAnnounceFrame(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal announce: %w", err)
	}
	return &frame, nil
}

func readAcceptFrame(ctx context.Context, ws *websocket.Conn) (*generated.AcceptFrame, error) {
	messageType, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("binary message")
	}
	tag, err := generated.UnmarshalRunnerFrameTag(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal tag: %w", err)
	}
	if tag.Type != generated.RunnerFrameKindAccept {
		return nil, fmt.Errorf("expected accept, got %s", tag.Type)
	}
	frame, err := generated.UnmarshalAcceptFrame(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal accept: %w", err)
	}
	return &frame, nil
}

func readReportFrame(ctx context.Context, ws *websocket.Conn) (*generated.ReportFrame, error) {
	messageType, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("binary message")
	}
	tag, err := generated.UnmarshalRunnerFrameTag(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal tag: %w", err)
	}
	if tag.Type != generated.RunnerFrameKindReport {
		return nil, fmt.Errorf("expected report, got %s", tag.Type)
	}
	frame, err := generated.UnmarshalReportFrame(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal report: %w", err)
	}
	return &frame, nil
}

func sendFrame(ctx context.Context, ws *websocket.Conn, f interface {
	Marshal() ([]byte, error)
}) error {
	data, err := f.Marshal()
	if err != nil {
		return err
	}
	return ws.Write(ctx, websocket.MessageText, data)
}

func makeRunnerConfig(t *testing.T, serverURL string) Config {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}
	return Config{
		BaseURL:     serverURL,
		Token:       "test-token",
		Capacity:    1,
		SecretStore: store,
		Reconnect:   Backoff{Initial: 10 * time.Millisecond, Max: 50 * time.Millisecond},
	}
}

func TestRunnerConnect_Success(t *testing.T) {
	var connectedSessions []Session
	var mu sync.Mutex

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}
		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	cfg.Hooks.OnConnected = func(s Session) {
		mu.Lock()
		connectedSessions = append(connectedSessions, s)
		mu.Unlock()
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("handled")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "OnConnected", func() bool { mu.Lock(); defer mu.Unlock(); return len(connectedSessions) > 0 })

	mu.Lock()
	session := connectedSessions[0]
	mu.Unlock()

	if session.ID == "" {
		t.Fatal("session ID is empty")
	}

	r.Stop(context.Background())
}

func TestRunnerConnect_BadToken(t *testing.T) {
	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			FailAuth: true,
		})
		return err
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("handled")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = r.Connect(ctx)
	var connectErr *ConnectError
	if !errors.As(err, &connectErr) {
		t.Fatalf("Connect: expected *ConnectError, got %v", err)
	}
	if connectErr.Reason != generated.ConnectFailureAuthenticationFailed {
		t.Fatalf("Connect: expected ConnectFailureAuthenticationFailed, got %s", connectErr.Reason)
	}

	// Should be able to call Connect again
	fakeTron.Close()
	fakeTron = newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			FailAuth: true,
		})
		return err
	})
	defer fakeTron.Close()

	cfg.BaseURL = fakeTron.URL
	r2, err := New(cfg)
	if err != nil {
		t.Fatalf("New (2): %v", err)
	}
	if err := r2.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("handled")
	}); err != nil {
		t.Fatalf("Handle (2): %v", err)
	}

	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = r2.Connect(ctx)
	if !errors.As(err, &connectErr) {
		t.Fatalf("Connect (2): expected *ConnectError, got %v", err)
	}
}

func TestRunnerConnect_Unreachable(t *testing.T) {
	cfg := makeRunnerConfig(t, "http://127.0.0.1:1")
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("handled")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err = r.Connect(ctx)
	var connectErr *ConnectError
	if !errors.As(err, &connectErr) {
		t.Fatalf("Connect: expected *ConnectError, got %v", err)
	}
	if connectErr.Reason != generated.Unreachable {
		t.Fatalf("Connect: expected Unreachable, got %s", connectErr.Reason)
	}
}

func TestRunnerConnect_AnnouncementRejected(t *testing.T) {
	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			RejectAnnouncement: true,
		})
		return err
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("handled")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = r.Connect(ctx)
	var connectErr *ConnectError
	if !errors.As(err, &connectErr) {
		t.Fatalf("Connect: expected *ConnectError, got %v", err)
	}
	if connectErr.Reason != generated.AnnouncementRejected {
		t.Fatalf("Connect: expected AnnouncementRejected, got %s", connectErr.Reason)
	}
	if connectErr.Violation == nil {
		t.Fatal("Connect: Violation is nil")
	}
}

func TestRunnerDelivery_OkOutcome(t *testing.T) {
	secret := "test-secret-123"
	var mu sync.Mutex

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		// Push a work frame on the authenticated connection
		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-123",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		accepted := generated.AcceptedFrame{
			DeliveryID: accept.DeliveryID,
			Secret:     secret,
			Type:       generated.TypeAccepted,
		}
		if err := sendFrame(ctx2, ws, &accepted); err != nil {
			return fmt.Errorf("send accepted: %w", err)
		}

		report, err := readReportFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read report: %w", err)
		}

		if report.Secret != secret {
			return fmt.Errorf("report secret mismatch: got %s, want %s", report.Secret, secret)
		}

		if report.Outcome.Ok == nil {
			return fmt.Errorf("report outcome should be Ok")
		}

		recorded := generated.ReportRecordedFrame{
			DeliveryID: report.DeliveryID,
			Late:       true,
			Type:       generated.TypeReportRecorded,
		}
		if err := sendFrame(ctx2, ws, &recorded); err != nil {
			return fmt.Errorf("send report_recorded: %w", err)
		}

		return nil
	})
	defer fakeTron.Close()

	var acceptedCalled, recordedCalled bool
	var recordedArg ReportRecorded

	cfg := makeRunnerConfig(t, fakeTron.URL)
	cfg.Hooks.OnDeliveryAccepted = func(d Delivery) {
		mu.Lock()
		acceptedCalled = true
		mu.Unlock()

		// Verify secret is in store
		secret, found, _ := cfg.SecretStore.Load(d.DeliveryID)
		if !found || secret != "test-secret-123" {
			t.Errorf("secret not in store after OnDeliveryAccepted")
		}
	}

	cfg.Hooks.OnReportRecorded = func(rr ReportRecorded) {
		mu.Lock()
		recordedCalled = true
		recordedArg = rr
		mu.Unlock()
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("success message")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "OnReportRecorded", func() bool { mu.Lock(); defer mu.Unlock(); return recordedCalled })

	mu.Lock()
	if !acceptedCalled {
		t.Fatal("OnDeliveryAccepted was not called")
	}
	if !recordedCalled {
		t.Fatal("OnReportRecorded was not called")
	}
	if recordedArg.Late != true {
		t.Fatal("ReportRecorded.Late should be true")
	}
	mu.Unlock()

	// Secret should no longer be in store
	_, found, _ := cfg.SecretStore.Load("delivery-123")
	if found {
		t.Fatal("secret should be removed from store after report_recorded")
	}

	r.Stop(context.Background())
}

func TestRunnerDelivery_ErrOutcome(t *testing.T) {
	secret := "test-secret-err"

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-err",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		accepted := generated.AcceptedFrame{
			DeliveryID: accept.DeliveryID,
			Secret:     secret,
			Type:       generated.TypeAccepted,
		}
		if err := sendFrame(ctx2, ws, &accepted); err != nil {
			return fmt.Errorf("send accepted: %w", err)
		}

		report, err := readReportFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read report: %w", err)
		}

		if report.Outcome.Err == nil {
			return fmt.Errorf("report outcome should be Err")
		}
		if !strings.Contains(*report.Outcome.Err, "failure message") {
			return fmt.Errorf("report Err message should contain 'failure message', got %s", *report.Outcome.Err)
		}

		recorded := generated.ReportRecordedFrame{
			DeliveryID: report.DeliveryID,
			Late:       false,
			Type:       generated.TypeReportRecorded,
		}
		if err := sendFrame(ctx2, ws, &recorded); err != nil {
			return fmt.Errorf("send report_recorded: %w", err)
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	recorded := make(chan struct{}, 1)
	cfg.Hooks.OnReportRecorded = func(ReportRecorded) { recorded <- struct{}{} }
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Err("failure message")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	select {
	case <-recorded:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the report to be recorded")
	}
	r.Stop(context.Background())
}

func TestRunnerAcceptRefused(t *testing.T) {
	var errorReceived error
	var mu sync.Mutex

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-refused",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		refused := generated.AcceptRefusedFrame{
			DeliveryID: accept.DeliveryID,
			Reason:     generated.DeliveryTimedOut,
			Type:       generated.TypeAcceptRefused,
		}
		if err := sendFrame(ctx2, ws, &refused); err != nil {
			return fmt.Errorf("send accept_refused: %w", err)
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	cfg.Hooks.OnError = func(err error) {
		mu.Lock()
		errorReceived = err
		mu.Unlock()
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		t.Fatal("handler should not be called on accept_refused")
		return Ok("")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "OnError", func() bool { mu.Lock(); defer mu.Unlock(); return errorReceived != nil })

	mu.Lock()
	if errorReceived == nil {
		t.Fatal("OnError was not called")
	}
	var refusedErr *AcceptRefusedError
	if !errors.As(errorReceived, &refusedErr) {
		t.Fatalf("OnError: expected *AcceptRefusedError, got %T", errorReceived)
	}
	if refusedErr.Reason != generated.DeliveryTimedOut {
		t.Fatalf("OnError: expected DeliveryTimedOut, got %s", refusedErr.Reason)
	}
	mu.Unlock()

	r.Stop(context.Background())
}

func TestRunnerReportRejected(t *testing.T) {
	secret := "test-secret-reject"
	var errorReceived error
	var mu sync.Mutex

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-reject",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		accepted := generated.AcceptedFrame{
			DeliveryID: accept.DeliveryID,
			Secret:     secret,
			Type:       generated.TypeAccepted,
		}
		if err := sendFrame(ctx2, ws, &accepted); err != nil {
			return fmt.Errorf("send accepted: %w", err)
		}

		report, err := readReportFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read report: %w", err)
		}

		rejected := generated.ReportRejectedFrame{
			DeliveryID: report.DeliveryID,
			Reason:     generated.WrongSecret,
			Type:       generated.TypeReportRejected,
		}
		if err := sendFrame(ctx2, ws, &rejected); err != nil {
			return fmt.Errorf("send report_rejected: %w", err)
		}

		// Count reports sent
		select {
		case <-time.After(500 * time.Millisecond):
		case <-ctx2.Done():
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	cfg.Hooks.OnError = func(err error) {
		mu.Lock()
		errorReceived = err
		mu.Unlock()
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("test")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "OnError", func() bool { mu.Lock(); defer mu.Unlock(); return errorReceived != nil })

	mu.Lock()
	if errorReceived == nil {
		t.Fatal("OnError was not called")
	}
	var rejectedErr *ReportRejectedError
	if !errors.As(errorReceived, &rejectedErr) {
		t.Fatalf("OnError: expected *ReportRejectedError, got %T", errorReceived)
	}
	if rejectedErr.Reason != generated.WrongSecret {
		t.Fatalf("OnError: expected WrongSecret, got %s", rejectedErr.Reason)
	}
	mu.Unlock()

	// Secret should still be in store
	stored, found, _ := cfg.SecretStore.Load("delivery-reject")
	if !found {
		t.Fatal("secret should still be in store after report_rejected")
	}
	if stored != secret {
		t.Fatalf("stored secret mismatch: got %s, want %s", stored, secret)
	}

	r.Stop(context.Background())
}

func TestRunnerRoutesDeliveryToHandlerByKey(t *testing.T) {
	var mu sync.Mutex
	var invoked []string
	reported := map[string]string{}

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1", "handler-2"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		for _, key := range []string{"handler-2", "handler-1"} {
			work := generated.WorkFrame{
				DeliveryID:     "delivery-" + key,
				RunID:          "run-456",
				JobID:          "job-789",
				JobName:        "test-job",
				HandlerKey:     key,
				ScheduledFor:   time.Now().Format(time.RFC3339),
				AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
				Type:           generated.TypeWork,
			}
			if err := sendFrame(ctx2, ws, &work); err != nil {
				return fmt.Errorf("send work: %w", err)
			}
			accept, err := readAcceptFrame(ctx2, ws)
			if err != nil {
				return fmt.Errorf("read accept: %w", err)
			}
			accepted := generated.AcceptedFrame{DeliveryID: accept.DeliveryID, Secret: "secret-" + key, Type: generated.TypeAccepted}
			if err := sendFrame(ctx2, ws, &accepted); err != nil {
				return fmt.Errorf("send accepted: %w", err)
			}
			report, err := readReportFrame(ctx2, ws)
			if err != nil {
				return fmt.Errorf("read report: %w", err)
			}
			if report.Outcome.Ok == nil {
				return fmt.Errorf("report outcome for %s should be Ok", key)
			}
			mu.Lock()
			reported[key] = *report.Outcome.Ok
			mu.Unlock()
			recorded := generated.ReportRecordedFrame{DeliveryID: report.DeliveryID, Type: generated.TypeReportRecorded}
			if err := sendFrame(ctx2, ws, &recorded); err != nil {
				return fmt.Errorf("send report_recorded: %w", err)
			}
		}
		return nil
	})
	defer fakeTron.Close()

	r, err := New(makeRunnerConfig(t, fakeTron.URL))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, key := range []string{"handler-1", "handler-2"} {
		key := key
		if err := r.Handle(key, func(ctx context.Context, d Delivery) Outcome {
			mu.Lock()
			invoked = append(invoked, key)
			mu.Unlock()
			return Ok("done by " + key)
		}); err != nil {
			t.Fatalf("Handle %s: %v", key, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "both reports", func() bool { mu.Lock(); defer mu.Unlock(); return len(reported) == 2 })

	mu.Lock()
	defer mu.Unlock()
	if len(invoked) != 2 || invoked[0] != "handler-2" || invoked[1] != "handler-1" {
		t.Fatalf("handlers invoked in order %v, want [handler-2 handler-1]", invoked)
	}
	for _, key := range []string{"handler-1", "handler-2"} {
		if want := "done by " + key; reported[key] != want {
			t.Fatalf("outcome for %s: got %q, want %q", key, reported[key], want)
		}
	}
	r.Stop(context.Background())
}

func TestRunnerUnknownHandlerKeyIsNotAccepted(t *testing.T) {
	var errorReceived error
	var mu sync.Mutex
	var accepted bool

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1", "handler-2"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			DeliveryID:     "delivery-unknown",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			HandlerKey:     "no-such-handler",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		// The runner must not answer with an accept frame; give it time to (wrongly) do so.
		readCtx, readCancel := context.WithTimeout(ctx2, 300*time.Millisecond)
		defer readCancel()
		if _, err := readAcceptFrame(readCtx, ws); err == nil {
			mu.Lock()
			accepted = true
			mu.Unlock()
		}
		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	cfg.Hooks.OnError = func(err error) {
		mu.Lock()
		errorReceived = err
		mu.Unlock()
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, key := range []string{"handler-1", "handler-2"} {
		if err := r.Handle(key, func(ctx context.Context, d Delivery) Outcome { return Ok("") }); err != nil {
			t.Fatalf("Handle %s: %v", key, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "OnError", func() bool { mu.Lock(); defer mu.Unlock(); return errorReceived != nil })
	time.Sleep(400 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	var unknownErr *UnknownHandlerError
	if !errors.As(errorReceived, &unknownErr) {
		t.Fatalf("OnError: expected *UnknownHandlerError, got %T", errorReceived)
	}
	if unknownErr.DeliveryID != "delivery-unknown" || unknownErr.HandlerKey != "no-such-handler" {
		t.Fatalf("OnError: unexpected error fields %+v", unknownErr)
	}
	if accepted {
		t.Fatal("runner accepted a delivery for an unregistered handler key")
	}
	r.Stop(context.Background())
}

func TestRunnerPanicHandler(t *testing.T) {
	secret := "test-secret-panic"

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-panic",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		accepted := generated.AcceptedFrame{
			DeliveryID: accept.DeliveryID,
			Secret:     secret,
			Type:       generated.TypeAccepted,
		}
		if err := sendFrame(ctx2, ws, &accepted); err != nil {
			return fmt.Errorf("send accepted: %w", err)
		}

		report, err := readReportFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read report: %w", err)
		}

		if report.Outcome.Err == nil {
			return fmt.Errorf("report outcome should be Err")
		}
		if !strings.Contains(*report.Outcome.Err, "handler panicked:") {
			return fmt.Errorf("report Err should mention panic, got %s", *report.Outcome.Err)
		}

		recorded := generated.ReportRecordedFrame{
			DeliveryID: report.DeliveryID,
			Late:       false,
			Type:       generated.TypeReportRecorded,
		}
		if err := sendFrame(ctx2, ws, &recorded); err != nil {
			return fmt.Errorf("send report_recorded: %w", err)
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	recorded := make(chan struct{}, 1)
	cfg.Hooks.OnReportRecorded = func(ReportRecorded) { recorded <- struct{}{} }
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		panic("intentional panic")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	select {
	case <-recorded:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the report to be recorded")
	}
	r.Stop(context.Background())
}

func TestRunnerReconnect(t *testing.T) {
	var connectedSessions []string
	var mu sync.Mutex
	var connectionCount atomic.Int32

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		n := connectionCount.Add(1)
		helper, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
			SessionID:         fmt.Sprintf("conn-%d", n),
		})
		if err != nil {
			return err
		}

		mu.Lock()
		connectedSessions = append(connectedSessions, helper.sessionID)
		mu.Unlock()

		if n == 1 {
			// Close after handshake on first connection
			time.Sleep(50 * time.Millisecond)
			ws.Close(websocket.StatusNormalClosure, "")
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	cfg.Hooks.OnConnected = func(s Session) {
		// Connection established
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	eventually(t, "a second session", func() bool { mu.Lock(); defer mu.Unlock(); return len(connectedSessions) >= 2 })

	mu.Lock()
	if len(connectedSessions) < 2 {
		t.Fatalf("expected at least 2 connections, got %d", len(connectedSessions))
	}
	if connectedSessions[0] == connectedSessions[1] {
		t.Fatal("reconnected session should have different ID")
	}
	mu.Unlock()

	r.Stop(context.Background())
}

func TestRunnerStop(t *testing.T) {
	var reportCount atomic.Int32
	handlerBlocking := make(chan struct{})
	handlerDone := make(chan struct{})
	handlerStarted := make(chan struct{})

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-stop",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		accepted := generated.AcceptedFrame{
			DeliveryID: accept.DeliveryID,
			Secret:     "stop-secret",
			Type:       generated.TypeAccepted,
		}
		if err := sendFrame(ctx2, ws, &accepted); err != nil {
			return fmt.Errorf("send accepted: %w", err)
		}

		// Wait for handler to be blocked
		<-handlerBlocking

		report, err := readReportFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read report: %w", err)
		}

		reportCount.Add(1)
		recorded := generated.ReportRecordedFrame{
			DeliveryID: report.DeliveryID,
			Late:       false,
			Type:       generated.TypeReportRecorded,
		}
		if err := sendFrame(ctx2, ws, &recorded); err != nil {
			return fmt.Errorf("send report_recorded: %w", err)
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		close(handlerStarted)
		handlerBlocking <- struct{}{}
		<-handlerDone
		return Ok("test")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	select {
	case <-handlerStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("handler never started")
	}

	// Stop in a goroutine
	stopDone := make(chan error, 1)
	go func() {
		stopDone <- r.Stop(context.Background())
	}()

	// Give Stop time to reach the drain
	time.Sleep(50 * time.Millisecond)

	// Stop should not have returned yet
	select {
	case <-stopDone:
		t.Fatal("Stop returned before handler finished")
	default:
	}

	// Release handler
	handlerDone <- struct{}{}

	// Stop should return now
	stopErr := <-stopDone
	if stopErr != nil {
		t.Fatalf("Stop: %v", stopErr)
	}

	if reportCount.Load() != 1 {
		t.Fatalf("expected 1 report, got %d", reportCount.Load())
	}
}

func TestRunnerStop_ExpiredContext(t *testing.T) {
	handlerBlocking := make(chan struct{}, 1)

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		work := generated.WorkFrame{
			HandlerKey:     "handler-1",
			DeliveryID:     "delivery-stop",
			RunID:          "run-456",
			JobID:          "job-789",
			JobName:        "test-job",
			ScheduledFor:   time.Now().Format(time.RFC3339),
			AcceptDeadline: time.Now().Add(10 * time.Second).Format(time.RFC3339),
			Type:           generated.TypeWork,
		}
		if err := sendFrame(ctx2, ws, &work); err != nil {
			return fmt.Errorf("send work: %w", err)
		}

		accept, err := readAcceptFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read accept: %w", err)
		}

		accepted := generated.AcceptedFrame{
			DeliveryID: accept.DeliveryID,
			Secret:     "stop-secret",
			Type:       generated.TypeAccepted,
		}
		if err := sendFrame(ctx2, ws, &accepted); err != nil {
			return fmt.Errorf("send accepted: %w", err)
		}

		// Wait forever
		<-time.After(60 * time.Second)
		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		handlerBlocking <- struct{}{}
		<-ctx.Done()
		return Ok("test")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	select {
	case <-handlerBlocking:
	case <-time.After(5 * time.Second):
		t.Fatal("handler never started")
	}

	// Stop with expired context
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stopCancel()

	stopErr := r.Stop(stopCtx)
	if stopErr == nil {
		t.Fatal("Stop should return context error")
	}
	if !errors.Is(stopErr, context.DeadlineExceeded) {
		t.Fatalf("Stop: expected DeadlineExceeded, got %v", stopErr)
	}
}

func TestRunnerReportPending(t *testing.T) {
	var reportReceived atomic.Bool

	fakeTron := newFakeTron(t, func(ctx context.Context, ws *websocket.Conn) error {
		_, err := newFakeRunnerHelper(ctx, ws, fakeRunnerOptions{
			ExpectHandlerKeys: []string{"handler-1"},
			ExpectCapacity:    1,
		})
		if err != nil {
			return err
		}

		ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		report, err := readReportFrame(ctx2, ws)
		if err != nil {
			return fmt.Errorf("read report: %w", err)
		}

		if report.Secret != "pending-secret" {
			return fmt.Errorf("report secret mismatch: got %s, want pending-secret", report.Secret)
		}

		reportReceived.Store(true)
		recorded := generated.ReportRecordedFrame{
			DeliveryID: report.DeliveryID,
			Late:       false,
			Type:       generated.TypeReportRecorded,
		}
		if err := sendFrame(ctx2, ws, &recorded); err != nil {
			return fmt.Errorf("send report_recorded: %w", err)
		}

		return nil
	})
	defer fakeTron.Close()

	cfg := makeRunnerConfig(t, fakeTron.URL)

	// Pre-populate the store
	if err := cfg.SecretStore.Save("delivery-pending", "pending-secret"); err != nil {
		t.Fatalf("Save: %v", err)
	}

	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := r.Handle("handler-1", func(ctx context.Context, d Delivery) Outcome {
		return Ok("")
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := r.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	reportErr := r.ReportPending(ctx, "delivery-pending", Ok("pending outcome"))
	if reportErr != nil {
		t.Fatalf("ReportPending: %v", reportErr)
	}

	if !reportReceived.Load() {
		t.Fatal("report was not received by server")
	}

	// Secret should be removed from store
	_, found, _ := cfg.SecretStore.Load("delivery-pending")
	if found {
		t.Fatal("secret should be removed after report_recorded")
	}

	r.Stop(context.Background())
}

func TestRunnerURL_Schemes(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
		wantErr  bool
	}{
		{
			name:     "http to ws",
			input:    "http://example.com:8080/foo/bar?query=value",
			expected: "ws://example.com:8080" + generated.RunnerChannelAddress,
		},
		{
			name:     "https to wss",
			input:    "https://example.com/path",
			expected: "wss://example.com" + generated.RunnerChannelAddress,
		},
		{
			name:     "ws unchanged",
			input:    "ws://example.com/old",
			expected: "ws://example.com" + generated.RunnerChannelAddress,
		},
		{
			name:     "wss unchanged",
			input:    "wss://example.com:8443/old",
			expected: "wss://example.com:8443" + generated.RunnerChannelAddress,
		},
		{
			name:    "ftp scheme",
			input:   "ftp://example.com",
			wantErr: true,
		},
		{
			name:    "empty host",
			input:   "http://",
			wantErr: true,
		},
		{
			name:    "invalid URL",
			input:   "ht!tp://example.com",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := RunnerURL(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("RunnerURL: expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("RunnerURL: %v", err)
			}
			if result != tt.expected {
				t.Fatalf("RunnerURL: got %q, want %q", result, tt.expected)
			}
		})
	}
}
