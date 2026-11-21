package tronrunner_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"

	tronrunner "github.com/umbra-yurei/tron-runner-sdk/packages/go"
	"github.com/umbra-yurei/tron-runner-sdk/packages/go/generated"
)

// The documented example, as the public package is used from outside it. The lines between the docs
// markers are the snippet shown on the Runners page and in the public book (tools/examples.ts), so a
// change that breaks them fails here.
func runDocumentedExample(ctx context.Context, reported <-chan struct{}) error {
	// docs:start
	store, err := tronrunner.NewFileSecretStore(os.Getenv("TRON_SECRET_DIR"))
	if err != nil {
		return err
	}
	runner, err := tronrunner.New(tronrunner.Config{
		BaseURL:     os.Getenv("TRON_URL"),
		Token:       os.Getenv("TRON_WORKER_KEY"),
		SecretStore: store,
	})
	if err != nil {
		return err
	}

	runner.Handle("send-report", func(ctx context.Context, d tronrunner.Delivery) tronrunner.Outcome {
		// Ok marks the run succeeded and Err marks it failed; both carry a message.
		return tronrunner.Ok("sent the report for " + d.JobName)
	})

	if err := runner.Connect(ctx); err != nil {
		return err
	}

	// ... keep the process alive; when it is told to shut down:
	// docs:hide
	<-reported
	// docs:show
	return runner.Stop(context.Background()) // finish in-flight work, report it, then close
	// docs:end
}

func TestDocumentedExampleRunsADeliveryAndReportsIt(t *testing.T) {
	const deliveryID = "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01"
	const secret = "the-secret"
	reported := make(chan struct{})
	served := make(chan error, 1)

	tron := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != generated.RunnerChannelAddress {
			http.NotFound(w, r)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		served <- serveOneDelivery(ctx, ws, deliveryID, secret, reported)
	}))
	defer tron.Close()

	t.Setenv("TRON_URL", tron.URL)
	t.Setenv("TRON_WORKER_KEY", "documented-key")
	t.Setenv("TRON_SECRET_DIR", t.TempDir())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := runDocumentedExample(ctx, reported); err != nil {
		t.Fatalf("the documented example: %v", err)
	}
	if err := <-served; err != nil {
		t.Fatal(err)
	}
}

// serveOneDelivery plays Tron: it authenticates and announces the runner, pushes one delivery, hands out the
// delivery's secret, checks the report that comes back and acknowledges it.
func serveOneDelivery(ctx context.Context, ws *websocket.Conn, deliveryID, secret string, reported chan<- struct{}) error {
	read := func(want generated.RunnerFrameKind) ([]byte, error) {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		tag, err := generated.UnmarshalRunnerFrameTag(data)
		if err != nil {
			return nil, err
		}
		if tag.Type != want {
			return nil, fmt.Errorf("expected a %s frame, got %s", want, tag.Type)
		}
		return data, nil
	}
	send := func(frame interface{ Marshal() ([]byte, error) }) error {
		data, err := frame.Marshal()
		if err != nil {
			return err
		}
		return ws.Write(ctx, websocket.MessageText, data)
	}

	if _, err := read(generated.RunnerFrameKindAuthenticate); err != nil {
		return err
	}
	if err := send(&generated.AuthenticatedFrame{SessionID: "session-1", Type: generated.TypeAuthenticated}); err != nil {
		return err
	}
	data, err := read(generated.RunnerFrameKindAnnounce)
	if err != nil {
		return err
	}
	announce, err := generated.UnmarshalAnnounceFrame(data)
	if err != nil {
		return err
	}
	if keys := announce.Announcement.HandlerKeys; len(keys) != 1 || keys[0] != "send-report" {
		return fmt.Errorf("the runner announced %v, want [send-report]", keys)
	}
	if err := send(&generated.AnnouncedFrame{Type: generated.TypeAnnounced}); err != nil {
		return err
	}

	now := time.Now().UTC()
	if err := send(&generated.WorkFrame{
		AcceptDeadline: now.Add(10 * time.Second).Format(time.RFC3339),
		DeliveryID:     deliveryID,
		JobID:          "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b03",
		JobName:        "nightly",
		RunID:          "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b02",
		ScheduledFor:   now.Format(time.RFC3339),
		Type:           generated.TypeWork,
	}); err != nil {
		return err
	}
	if _, err := read(generated.RunnerFrameKindAccept); err != nil {
		return err
	}
	if err := send(&generated.AcceptedFrame{DeliveryID: deliveryID, Secret: secret, Type: generated.TypeAccepted}); err != nil {
		return err
	}

	data, err = read(generated.RunnerFrameKindReport)
	if err != nil {
		return err
	}
	report, err := generated.UnmarshalReportFrame(data)
	if err != nil {
		return err
	}
	if report.DeliveryID != deliveryID || report.Secret != secret {
		return fmt.Errorf("the report names delivery %s with secret %q", report.DeliveryID, report.Secret)
	}
	if report.Outcome.Ok == nil || *report.Outcome.Ok != "sent the report for nightly" {
		return fmt.Errorf("the report outcome is %+v, want Ok(sent the report for nightly)", report.Outcome)
	}
	close(reported)
	return send(&generated.ReportRecordedFrame{DeliveryID: deliveryID, Late: false, Type: generated.TypeReportRecorded})
}
