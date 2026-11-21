package tronrunner

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

// Runner is a connected Tron worker. Create it with New, register handlers with Handle, then Connect.
type Runner struct {
	url     string
	token   string
	cfg     Config
	backoff Backoff
	store   SecretStore
	hooks   Hooks

	baseCtx    context.Context
	cancelBase context.CancelFunc
	owed       *tracker

	mu       sync.Mutex
	handlers map[string]Handler
	started  bool
	closed   bool
	current  *session
	ready    chan struct{}
	done     chan struct{}
	fatal    error
}

// RunnerURL turns Tron's base URL (http, https, ws or wss) into the runner WebSocket URL, using
// the channel address from the generated bindings.
func RunnerURL(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("tronrunner: parse base URL: %w", err)
	}
	switch parsed.Scheme {
	case "http", "ws":
		parsed.Scheme = "ws"
	case "https", "wss":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("tronrunner: base URL scheme %q is not http, https, ws or wss", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", errors.New("tronrunner: base URL has no host")
	}
	parsed.Path = generated.RunnerChannelAddress
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// New validates the configuration and prepares a runner; it does not connect.
func New(cfg Config) (*Runner, error) {
	wsURL, err := RunnerURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	if cfg.Token == "" {
		return nil, errors.New("tronrunner: worker API key token is empty")
	}
	if cfg.Capacity < 0 {
		return nil, errors.New("tronrunner: capacity is negative")
	}
	if cfg.Capacity == 0 {
		cfg.Capacity = 1
	}
	store := cfg.SecretStore
	if store == nil {
		directory, err := DefaultSecretDirectory()
		if err != nil {
			return nil, err
		}
		if store, err = NewFileSecretStore(directory); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Runner{
		url:        wsURL,
		token:      cfg.Token,
		cfg:        cfg,
		backoff:    cfg.Reconnect.withDefaults(),
		store:      store,
		hooks:      cfg.Hooks,
		baseCtx:    ctx,
		cancelBase: cancel,
		owed:       newTracker(),
		handlers:   map[string]Handler{},
		ready:      make(chan struct{}),
	}, nil
}

// Handle registers the handler for a handler key; the registered keys are what Connect announces,
// and Tron only pushes work for a job whose handler key a session announced.
func (r *Runner) Handle(key string, handler Handler) error {
	if key == "" || handler == nil {
		return errors.New("tronrunner: a handler needs a key and a function")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return ErrAlreadyStarted
	}
	if _, exists := r.handlers[key]; exists {
		return fmt.Errorf("tronrunner: handler key %q registered twice", key)
	}
	r.handlers[key] = handler
	return nil
}

// Connect authenticates and announces. If the first attempt fails it returns a *ConnectError and
// the runner may be Connected again; after it succeeds the runner keeps the connection alive in
// the background, reconnecting with backoff (a fresh authenticate and announce each time).
func (r *Runner) Connect(ctx context.Context) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return ErrClosed
	}
	if r.started {
		r.mu.Unlock()
		return ErrAlreadyStarted
	}
	if len(r.handlers) == 0 {
		r.mu.Unlock()
		return ErrNoHandlers
	}
	r.started = true
	r.mu.Unlock()

	s, early, err := r.dial(ctx)
	if err != nil {
		r.mu.Lock()
		r.started = false
		r.mu.Unlock()
		return err
	}
	r.mu.Lock()
	r.done = make(chan struct{})
	r.mu.Unlock()
	r.install(s)
	go r.supervise(s, early)
	return nil
}

// Wait blocks until the runner has stopped and returns why: nil after Stop, or the *ConnectError
// of a reconnect Tron refused for good.
func (r *Runner) Wait() error {
	r.mu.Lock()
	done := r.done
	r.mu.Unlock()
	if done == nil {
		return ErrNotConnected
	}
	<-done
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fatal
}

// Pending lists the deliveries the secret store holds: accepted but not yet reported.
func (r *Runner) Pending() ([]string, error) { return r.store.Pending() }

// ReportPending reports an outcome for a delivery this process or an earlier one accepted, using
// the secret in the store, and returns once Tron answered: nil when recorded (the secret is then
// removed), *ReportRejectedError when Tron rejected it (the secret is kept).
func (r *Runner) ReportPending(ctx context.Context, deliveryID string, outcome Outcome) error {
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	if !started {
		return ErrNotConnected
	}
	if !r.owed.begin() {
		return ErrClosed
	}
	defer r.owed.end()
	return r.reportStored(ctx, deliveryID, outcome)
}

// reportStored reports with the secret the store holds, which is the source of truth for a delivery's secret.
func (r *Runner) reportStored(ctx context.Context, deliveryID string, outcome Outcome) error {
	secret, found, err := r.store.Load(deliveryID)
	if err != nil {
		return &SecretStoreError{DeliveryID: deliveryID, Err: err}
	}
	if !found {
		return fmt.Errorf("%w: %s", ErrNoStoredSecret, deliveryID)
	}
	return r.settle(ctx, deliveryID, secret, outcome)
}

// Stop drains and closes: it stops taking new work, waits for in-flight handlers to finish and for
// Tron to answer their reports, then closes the connection. If ctx ends first the handlers' contexts
// are cancelled, the connection is closed and ctx's error is returned.
func (r *Runner) Stop(ctx context.Context) error {
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	if !started {
		r.shutdown()
		return nil
	}
	var result error
	select {
	case <-r.owed.drain():
	case <-ctx.Done():
		result = ctx.Err()
	}
	r.mu.Lock()
	r.closed = true
	s := r.current
	done := r.done
	r.mu.Unlock()
	if s != nil {
		if result == nil {
			_ = s.ws.Close(websocket.StatusNormalClosure, "")
		} else {
			_ = s.ws.CloseNow()
		}
	}
	r.cancelBase()
	if done != nil {
		<-done
	}
	return result
}

// shutdown marks the runner closed and cancels everything that waits on it.
func (r *Runner) shutdown() {
	r.mu.Lock()
	r.closed = true
	r.mu.Unlock()
	r.cancelBase()
}

func (r *Runner) fire(err error) {
	if r.hooks.OnError != nil {
		r.hooks.OnError(err)
	}
}

func (r *Runner) install(s *session) {
	r.mu.Lock()
	r.current = s
	close(r.ready)
	r.mu.Unlock()
}

func (r *Runner) uninstall(s *session) {
	r.mu.Lock()
	if r.current == s {
		r.current = nil
		r.ready = make(chan struct{})
	}
	r.mu.Unlock()
	close(s.lost)
}

func (r *Runner) awaitSession() (*session, error) {
	for {
		r.mu.Lock()
		s, ready := r.current, r.ready
		r.mu.Unlock()
		if s != nil {
			return s, nil
		}
		select {
		case <-ready:
		case <-r.baseCtx.Done():
			return nil, ErrClosed
		}
	}
}

func (r *Runner) isClosed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closed
}

// supervise reads the current connection and replaces it with backoff when it is lost.
func (r *Runner) supervise(s *session, early []generated.WorkFrame) {
	defer close(r.done)
	delay := r.backoff.Initial
	for {
		if r.hooks.OnConnected != nil {
			r.hooks.OnConnected(Session{ID: s.id})
		}
		for _, work := range early {
			r.onWork(s, work)
		}
		r.readLoop(s)
		r.uninstall(s)
		for {
			if r.isClosed() || r.baseCtx.Err() != nil {
				return
			}
			select {
			case <-time.After(delay):
			case <-r.baseCtx.Done():
				return
			}
			next, nextEarly, err := r.dial(r.baseCtx)
			if err == nil {
				s, early, delay = next, nextEarly, r.backoff.Initial
				r.install(s)
				break
			}
			var connectErr *ConnectError
			if errors.As(err, &connectErr) && connectErr.Reason != generated.Unreachable {
				r.mu.Lock()
				r.fatal = err
				r.mu.Unlock()
				r.shutdown()
				r.fire(err)
				return
			}
			delay = min(delay*2, r.backoff.Max)
		}
	}
}

// dial opens a connection, authenticates and announces. Work frames that race the announcement
// (a session is eligible for work as soon as it authenticates) are returned to be handled.
func (r *Runner) dial(ctx context.Context) (*session, []generated.WorkFrame, error) {
	ctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, r.url, nil)
	if err != nil {
		return nil, nil, &ConnectError{Reason: generated.Unreachable, Cause: err}
	}
	s, early, err := r.handshake(ctx, ws)
	if err != nil {
		_ = ws.CloseNow()
		return nil, nil, err
	}
	return s, early, nil
}

func readFrame(ctx context.Context, ws *websocket.Conn) (frame, error) {
	messageType, data, err := ws.Read(ctx)
	if err != nil {
		return frame{}, err
	}
	if messageType != websocket.MessageText {
		return frame{}, &UnexpectedFrameError{Err: errors.New("binary message")}
	}
	return decodeFrame(data)
}

func (r *Runner) handshake(ctx context.Context, ws *websocket.Conn) (*session, []generated.WorkFrame, error) {
	transport := func(err error) error { return &ConnectError{Reason: generated.Unreachable, Cause: err} }
	s := newSession(ws, "")
	authenticate := generated.AuthenticateFrame{Token: r.token, Type: generated.TypeAuthenticate}
	if err := s.send(ctx, &authenticate); err != nil {
		return nil, nil, transport(err)
	}
	first, err := readFrame(ctx, ws)
	if err != nil {
		return nil, nil, transport(err)
	}
	switch {
	case first.AuthenticationFailed != nil:
		return nil, nil, &ConnectError{Reason: generated.ConnectFailureAuthenticationFailed}
	case first.Authenticated == nil:
		return nil, nil, transport(&UnexpectedFrameError{Kind: first.kind()})
	}
	s.id = first.Authenticated.SessionID

	if err := s.send(ctx, r.announcement()); err != nil {
		return nil, nil, transport(err)
	}
	var early []generated.WorkFrame
	for {
		next, err := readFrame(ctx, ws)
		if err != nil {
			return nil, nil, transport(err)
		}
		switch {
		case next.Announced != nil:
			return s, early, nil
		case next.Work != nil:
			early = append(early, *next.Work)
		case next.ProtocolError != nil:
			violation := next.ProtocolError.Reason
			return nil, nil, &ConnectError{Reason: generated.AnnouncementRejected, Violation: &violation}
		case next.AuthenticationFailed != nil:
			return nil, nil, &ConnectError{Reason: generated.ConnectFailureAuthenticationFailed}
		default:
			return nil, nil, transport(&UnexpectedFrameError{Kind: next.kind()})
		}
	}
}

func (r *Runner) announcement() *generated.AnnounceFrame {
	r.mu.Lock()
	keys := make([]string, 0, len(r.handlers))
	for key := range r.handlers {
		keys = append(keys, key)
	}
	r.mu.Unlock()
	sort.Strings(keys)
	version := generated.RunnerProtocolVersion(generated.ProtocolVersion)
	sdkVersion := SDKVersion
	announcement := generated.RunnerAnnouncement{
		ConcurrencyCapacity: int64(r.cfg.Capacity),
		HandlerKeys:         keys,
		ProtocolVersion:     &version,
		SDKVersion:          &sdkVersion,
	}
	if r.cfg.DisplayName != "" {
		announcement.DisplayName = &r.cfg.DisplayName
	}
	if r.cfg.RunnerVersion != "" {
		announcement.RunnerVersion = &r.cfg.RunnerVersion
	}
	return &generated.AnnounceFrame{Announcement: announcement, Type: generated.TypeAnnounce}
}

// readLoop dispatches frames until the connection ends. It never blocks on a handler.
func (r *Runner) readLoop(s *session) {
	pingCtx, stopPing := context.WithCancel(r.baseCtx)
	defer stopPing()
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(pingCtx, pingTimeout)
				err := s.ws.Ping(ctx)
				cancel()
				if err != nil && pingCtx.Err() == nil {
					_ = s.ws.CloseNow()
					return
				}
			}
		}
	}()
	for {
		f, err := readFrame(r.baseCtx, s.ws)
		if err != nil {
			var unexpected *UnexpectedFrameError
			if errors.As(err, &unexpected) {
				r.fire(err)
				continue
			}
			return
		}
		r.dispatch(s, f)
	}
}

func (r *Runner) dispatch(s *session, f frame) {
	switch {
	case f.Work != nil:
		r.onWork(s, *f.Work)
	case f.Accepted != nil:
		if err := s.resolveAccept(f.Accepted.DeliveryID, acceptAnswer{secret: f.Accepted.Secret}); err != nil {
			r.fire(unsolicited(f, err))
		}
	case f.AcceptRefused != nil:
		reason := f.AcceptRefused.Reason
		if err := s.resolveAccept(f.AcceptRefused.DeliveryID, acceptAnswer{refusal: &reason}); err != nil {
			r.fire(unsolicited(f, err))
		}
	case f.ReportRecorded != nil:
		if err := s.resolveReport(f.ReportRecorded.DeliveryID, reportAnswer{late: f.ReportRecorded.Late}); err != nil {
			r.fire(unsolicited(f, err))
		}
	case f.ReportRejected != nil:
		reason := f.ReportRejected.Reason
		if err := s.resolveReport(f.ReportRejected.DeliveryID, reportAnswer{rejection: &reason}); err != nil {
			r.fire(unsolicited(f, err))
		}
	case f.ProtocolError != nil:
		r.fire(&ProtocolError{Reason: f.ProtocolError.Reason})
	default:
		r.fire(&UnexpectedFrameError{Kind: f.kind()})
	}
}

// route picks the handler for a delivery. Protocol v1 `work` frames do not name the handler key
// they were dispatched for, so only a runner with exactly one handler can route.
func (r *Runner) route(work generated.WorkFrame) (Handler, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.handlers) != 1 {
		return nil, &UnroutableDeliveryError{DeliveryID: work.DeliveryID, HandlerCount: len(r.handlers)}
	}
	for _, handler := range r.handlers {
		return handler, nil
	}
	return nil, nil
}

func newDelivery(work generated.WorkFrame) (Delivery, error) {
	scheduled, err := time.Parse(time.RFC3339, work.ScheduledFor)
	if err != nil {
		return Delivery{}, fmt.Errorf("scheduled_for: %w", err)
	}
	deadline, err := time.Parse(time.RFC3339, work.AcceptDeadline)
	if err != nil {
		return Delivery{}, fmt.Errorf("accept_deadline: %w", err)
	}
	return Delivery{
		DeliveryID:     work.DeliveryID,
		RunID:          work.RunID,
		JobID:          work.JobID,
		JobName:        work.JobName,
		ScheduledFor:   scheduled,
		AcceptDeadline: deadline,
	}, nil
}

// onWork accepts a delivery immediately (before anything else can delay it) and hands the rest to a goroutine.
func (r *Runner) onWork(s *session, work generated.WorkFrame) {
	if !r.owed.begin() {
		return
	}
	handler, err := r.route(work)
	if err == nil {
		var delivery Delivery
		if delivery, err = newDelivery(work); err == nil {
			answer := s.expectAccept(work.DeliveryID)
			accept := generated.AcceptFrame{DeliveryID: work.DeliveryID, Type: generated.TypeAccept}
			if sendErr := s.send(r.baseCtx, &accept); sendErr != nil {
				s.dropAccept(work.DeliveryID)
				r.owed.end()
				_ = s.ws.CloseNow()
				r.fire(&DeliveryAbandonedError{DeliveryID: work.DeliveryID})
				return
			}
			go r.deliver(s, delivery, handler, answer)
			return
		}
		err = &UnexpectedFrameError{Kind: generated.ServerFrameKindWork, Err: err}
	}
	r.owed.end()
	r.fire(err)
}

func (r *Runner) deliver(s *session, delivery Delivery, handler Handler, answered chan acceptAnswer) {
	defer r.owed.end()
	var answer acceptAnswer
	select {
	case answer = <-answered:
	case <-s.lost:
		select {
		case answer = <-answered:
		default:
			r.fire(&DeliveryAbandonedError{DeliveryID: delivery.DeliveryID})
			return
		}
	}
	if answer.refusal != nil {
		r.fire(&AcceptRefusedError{DeliveryID: delivery.DeliveryID, Reason: *answer.refusal})
		return
	}
	if err := r.store.Save(delivery.DeliveryID, answer.secret); err != nil {
		r.fire(&SecretStoreError{DeliveryID: delivery.DeliveryID, Err: err})
		return
	}
	if r.hooks.OnDeliveryAccepted != nil {
		r.hooks.OnDeliveryAccepted(delivery)
	}
	outcome := r.run(handler, delivery)
	if err := r.reportStored(r.baseCtx, delivery.DeliveryID, outcome); err != nil && !errors.Is(err, ErrClosed) {
		r.fire(err)
	}
}

func (r *Runner) run(handler Handler, delivery Delivery) (outcome Outcome) {
	defer func() {
		if recovered := recover(); recovered != nil {
			outcome = Err(fmt.Sprintf("handler panicked: %v", recovered))
		}
	}()
	return handler(r.baseCtx, delivery)
}

// settle reports until Tron answers, then removes the secret (recorded) or keeps it (rejected).
func (r *Runner) settle(ctx context.Context, deliveryID, secret string, outcome Outcome) error {
	answer, err := r.report(ctx, deliveryID, secret, outcome.wire())
	if err != nil {
		return err
	}
	if answer.rejection != nil {
		return &ReportRejectedError{DeliveryID: deliveryID, Reason: *answer.rejection}
	}
	removeErr := r.store.Remove(deliveryID)
	if r.hooks.OnReportRecorded != nil {
		r.hooks.OnReportRecorded(ReportRecorded{DeliveryID: deliveryID, Late: answer.late})
	}
	if removeErr != nil {
		return &SecretStoreError{DeliveryID: deliveryID, Err: removeErr}
	}
	return nil
}

// report sends the report on the current connection and waits for Tron's answer; if the
// connection is lost first it waits for the replacement and sends again.
func (r *Runner) report(ctx context.Context, deliveryID, secret string, outcome generated.RunOutcome) (reportAnswer, error) {
	for {
		s, err := r.awaitSession()
		if err != nil {
			return reportAnswer{}, err
		}
		answered, err := s.expectReport(deliveryID)
		if err != nil {
			return reportAnswer{}, err
		}
		frame := generated.ReportFrame{DeliveryID: deliveryID, Outcome: outcome, Secret: secret, Type: generated.TypeReport}
		if err := s.send(ctx, &frame); err != nil {
			s.dropReport(deliveryID)
			_ = s.ws.CloseNow()
		} else {
			select {
			case answer := <-answered:
				return answer, nil
			case <-s.lost:
				select {
				case answer := <-answered:
					return answer, nil
				default:
				}
			case <-r.baseCtx.Done():
				return reportAnswer{}, ErrClosed
			case <-ctx.Done():
				return reportAnswer{}, ctx.Err()
			}
		}
		select {
		case <-s.lost:
		case <-r.baseCtx.Done():
			return reportAnswer{}, ErrClosed
		case <-ctx.Done():
			return reportAnswer{}, ctx.Err()
		}
	}
}
