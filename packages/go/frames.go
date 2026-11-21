package tronrunner

import (
	"context"
	"errors"
	"sync"

	"github.com/coder/websocket"
	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

// frame is one decoded Tron frame: exactly one field is set. It is decoded by reading only the
// generated `type` tag and then the generated decoder for that kind.
type frame struct {
	Authenticated        *generated.AuthenticatedFrame
	Announced            *generated.AnnouncedFrame
	AuthenticationFailed *generated.AuthenticationFailedFrame
	Work                 *generated.WorkFrame
	Accepted             *generated.AcceptedFrame
	AcceptRefused        *generated.AcceptRefusedFrame
	ReportRecorded       *generated.ReportRecordedFrame
	ReportRejected       *generated.ReportRejectedFrame
	ProtocolError        *generated.ProtocolErrorFrame
}

func (f frame) kind() generated.ServerFrameKind {
	switch {
	case f.Authenticated != nil:
		return generated.ServerFrameKindAuthenticated
	case f.Announced != nil:
		return generated.ServerFrameKindAnnounced
	case f.AuthenticationFailed != nil:
		return generated.ServerFrameKindAuthenticationFailed
	case f.Work != nil:
		return generated.ServerFrameKindWork
	case f.Accepted != nil:
		return generated.ServerFrameKindAccepted
	case f.AcceptRefused != nil:
		return generated.ServerFrameKindAcceptRefused
	case f.ReportRecorded != nil:
		return generated.ServerFrameKindReportRecorded
	case f.ReportRejected != nil:
		return generated.ServerFrameKindReportRejected
	default:
		return generated.ServerFrameKindProtocolError
	}
}

func decodeFrame(data []byte) (frame, error) {
	tag, err := generated.UnmarshalServerFrameTag(data)
	if err != nil {
		return frame{}, &UnexpectedFrameError{Err: err}
	}
	var out frame
	switch tag.Type {
	case generated.ServerFrameKindAuthenticated:
		var f generated.AuthenticatedFrame
		f, err = generated.UnmarshalAuthenticatedFrame(data)
		out.Authenticated = &f
	case generated.ServerFrameKindAnnounced:
		var f generated.AnnouncedFrame
		f, err = generated.UnmarshalAnnouncedFrame(data)
		out.Announced = &f
	case generated.ServerFrameKindAuthenticationFailed:
		var f generated.AuthenticationFailedFrame
		f, err = generated.UnmarshalAuthenticationFailedFrame(data)
		out.AuthenticationFailed = &f
	case generated.ServerFrameKindWork:
		var f generated.WorkFrame
		f, err = generated.UnmarshalWorkFrame(data)
		out.Work = &f
	case generated.ServerFrameKindAccepted:
		var f generated.AcceptedFrame
		f, err = generated.UnmarshalAcceptedFrame(data)
		out.Accepted = &f
	case generated.ServerFrameKindAcceptRefused:
		var f generated.AcceptRefusedFrame
		f, err = generated.UnmarshalAcceptRefusedFrame(data)
		out.AcceptRefused = &f
	case generated.ServerFrameKindReportRecorded:
		var f generated.ReportRecordedFrame
		f, err = generated.UnmarshalReportRecordedFrame(data)
		out.ReportRecorded = &f
	case generated.ServerFrameKindReportRejected:
		var f generated.ReportRejectedFrame
		f, err = generated.UnmarshalReportRejectedFrame(data)
		out.ReportRejected = &f
	case generated.ServerFrameKindProtocolError:
		var f generated.ProtocolErrorFrame
		f, err = generated.UnmarshalProtocolErrorFrame(data)
		out.ProtocolError = &f
	default:
		return frame{}, &UnexpectedFrameError{Kind: tag.Type}
	}
	if err != nil {
		return frame{}, &UnexpectedFrameError{Kind: tag.Type, Err: err}
	}
	return out, nil
}

type marshaler interface{ Marshal() ([]byte, error) }

type acceptAnswer struct {
	secret  string
	refusal *generated.AcceptRefusal
}

type reportAnswer struct {
	late      bool
	rejection *generated.ReportRejection
}

// session is one authenticated, announced connection and the answers it is still waiting for.
// Answers are correlated per connection, so a delivery pushed on a dead session can never be
// confused with one on its replacement.
type session struct {
	ws   *websocket.Conn
	id   string
	lost chan struct{}

	mu      sync.Mutex
	accepts map[string]chan acceptAnswer
	reports map[string]chan reportAnswer
}

func newSession(ws *websocket.Conn, id string) *session {
	return &session{
		ws:      ws,
		id:      id,
		lost:    make(chan struct{}),
		accepts: map[string]chan acceptAnswer{},
		reports: map[string]chan reportAnswer{},
	}
}

func (s *session) send(ctx context.Context, f marshaler) error {
	data, err := f.Marshal()
	if err != nil {
		return err
	}
	return s.ws.Write(ctx, websocket.MessageText, data)
}

func (s *session) expectAccept(deliveryID string) chan acceptAnswer {
	ch := make(chan acceptAnswer, 1)
	s.mu.Lock()
	s.accepts[deliveryID] = ch
	s.mu.Unlock()
	return ch
}

func (s *session) dropAccept(deliveryID string) {
	s.mu.Lock()
	delete(s.accepts, deliveryID)
	s.mu.Unlock()
}

func (s *session) expectReport(deliveryID string) (chan reportAnswer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, busy := s.reports[deliveryID]; busy {
		return nil, ErrReportInProgress
	}
	ch := make(chan reportAnswer, 1)
	s.reports[deliveryID] = ch
	return ch, nil
}

func (s *session) dropReport(deliveryID string) {
	s.mu.Lock()
	delete(s.reports, deliveryID)
	s.mu.Unlock()
}

func (s *session) resolveAccept(deliveryID string, answer acceptAnswer) error {
	s.mu.Lock()
	ch, ok := s.accepts[deliveryID]
	delete(s.accepts, deliveryID)
	s.mu.Unlock()
	if !ok {
		return errors.New("no accept is awaiting this answer")
	}
	ch <- answer
	return nil
}

func (s *session) resolveReport(deliveryID string, answer reportAnswer) error {
	s.mu.Lock()
	ch, ok := s.reports[deliveryID]
	delete(s.reports, deliveryID)
	s.mu.Unlock()
	if !ok {
		return errors.New("no report is awaiting this answer")
	}
	ch <- answer
	return nil
}

func unsolicited(f frame, cause error) error {
	return &UnexpectedFrameError{Kind: f.kind(), Err: cause}
}
