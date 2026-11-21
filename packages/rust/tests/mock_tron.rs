//! The SDK against a scripted Tron on a local socket, using only the generated frame types.
use cruma_tron_runner::{
    protocol::{
        AcceptFrame, AcceptRefusal, AcceptRefusedEventType, AcceptRefusedFrame, AcceptedFrame, AcceptedFrameType, AnnounceFrame,
        AnnouncedFrame, AnnouncedFrameType, AuthenticateFrame, AuthenticatedFrame, AuthenticatedFrameType, AuthenticationFailedFrame,
        AuthenticationFailedFrameType, ReportFrame, ReportRecordedEventType, ReportRecordedFrame, RunnerFrameKind, RunnerFrameTag,
        RunnerProtocolVersion, WorkFrame, WorkFrameType,
    },
    Backoff, Endpoint, Error, Event, FileSecretStore, Runner, SecretStore, SDK_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

type Server = WebSocketStream<tokio::net::TcpStream>;

const DELIVERY: &str = "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01";

async fn listen() -> (TcpListener, Endpoint) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Endpoint::from_websocket_url(&format!("ws://{}/", listener.local_addr().unwrap())).unwrap();
    (listener, endpoint)
}

async fn send<T: Serialize>(server: &mut Server, frame: &T) {
    server.send(Message::text(serde_json::to_string(frame).unwrap())).await.unwrap();
}

async fn receive(server: &mut Server) -> String {
    loop {
        match server.next().await.expect("the runner closed the connection").unwrap() {
            Message::Text(text) => return text.as_str().to_owned(),
            Message::Close(_) => panic!("the runner closed the connection"),
            _ => {}
        }
    }
}

async fn receive_as<T: DeserializeOwned>(server: &mut Server, kind: RunnerFrameKind) -> T {
    let text = receive(server).await;
    let tag: RunnerFrameTag = serde_json::from_str(&text).unwrap();
    assert_eq!(tag.runner_frame_tag_type, kind);
    serde_json::from_str(&text).unwrap()
}

/// Accepts a connection, answers authentication and the announcement as Tron does, and returns the announcement.
async fn welcome(listener: &TcpListener) -> (Server, AnnounceFrame) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut server = accept_async(stream).await.unwrap();
    receive_as::<AuthenticateFrame>(&mut server, RunnerFrameKind::Authenticate).await;
    send(
        &mut server,
        &AuthenticatedFrame {
            session_id: "session".into(),
            authenticated_frame_type: AuthenticatedFrameType::Authenticated,
            worker_api_key_id: "key".into(),
        },
    )
    .await;
    let announce: AnnounceFrame = receive_as(&mut server, RunnerFrameKind::Announce).await;
    send(
        &mut server,
        &AnnouncedFrame {
            announced_frame_type: AnnouncedFrameType::Announced,
        },
    )
    .await;
    (server, announce)
}

fn work() -> WorkFrame {
    WorkFrame {
        accept_deadline: "2026-01-02T03:04:35Z".into(),
        delivery_id: DELIVERY.into(),
        job_id: "job".into(),
        job_name: "nightly".into(),
        run_id: "run".into(),
        scheduled_for: "2026-01-02T03:04:05Z".into(),
        work_frame_type: WorkFrameType::Work,
    }
}

fn events() -> (impl Fn(Event) + Send + Sync + 'static, mpsc::UnboundedReceiver<Event>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    (move |event| drop(sender.send(event)), receiver)
}

async fn next_event(receiver: &mut mpsc::UnboundedReceiver<Event>) -> Event {
    tokio::time::timeout(Duration::from_secs(10), receiver.recv())
        .await
        .expect("no event in time")
        .expect("event channel closed")
}

#[tokio::test]
async fn a_rejected_key_is_a_typed_error() {
    let (listener, endpoint) = listen().await;
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = accept_async(stream).await.unwrap();
        receive(&mut server).await;
        send(
            &mut server,
            &AuthenticationFailedFrame {
                authentication_failed_frame_type: AuthenticationFailedFrameType::AuthenticationFailed,
            },
        )
        .await;
    });
    let result = Runner::builder(endpoint, "bad")
        .on("h", |_| async { Ok(String::new()) })
        .connect()
        .await;
    assert!(matches!(result, Err(Error::AuthenticationFailed)));
}

#[tokio::test]
async fn an_unreachable_tron_is_a_typed_error() {
    let (listener, endpoint) = listen().await;
    drop(listener);
    let result = Runner::builder(endpoint, "t")
        .on("h", |_| async { Ok(String::new()) })
        .connect()
        .await;
    assert!(matches!(result, Err(Error::Unreachable(_))));
}

#[tokio::test]
async fn at_least_one_handler_is_required() {
    let (_listener, endpoint) = listen().await;
    assert!(matches!(
        Runner::builder(endpoint, "t").connect().await,
        Err(Error::Configuration(_))
    ));
}

#[tokio::test]
async fn announces_accepts_persists_reports_and_drains() {
    let (listener, endpoint) = listen().await;
    let directory = tempfile::tempdir().unwrap();
    let store = FileSecretStore::new(directory.path()).unwrap();
    let (callback, mut events) = events();
    let invoked = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&invoked);
    let seen_store = store.clone();
    let runner = tokio::spawn(
        Runner::builder(endpoint, "token")
            .concurrency_capacity(3)
            .display_name("mock")
            .secret_store(store.clone())
            .on_event(callback)
            .on("nightly", move |job| {
                let seen = Arc::clone(&seen);
                let store = seen_store.clone();
                async move {
                    // The secret was saved before this handler was invoked.
                    assert_eq!(store.load(&job.delivery_id).await.unwrap().as_deref(), Some("the-secret"));
                    seen.lock().unwrap().push(job);
                    Ok("done".to_owned())
                }
            })
            .connect(),
    );
    let (mut server, announce) = welcome(&listener).await;
    let runner = runner.await.unwrap().unwrap();
    let announcement = announce.announcement;
    assert_eq!(announcement.handler_keys, ["nightly"]);
    assert_eq!(announcement.concurrency_capacity, 3);
    assert_eq!(announcement.display_name.as_deref(), Some("mock"));
    assert_eq!(announcement.protocol_version, Some(RunnerProtocolVersion::V1));
    assert_eq!(announcement.sdk_version.as_deref(), Some(SDK_VERSION));
    assert!(matches!(next_event(&mut events).await, Event::Connected { session_id } if session_id == "session"));

    send(&mut server, &work()).await;
    let accept: AcceptFrame = receive_as(&mut server, RunnerFrameKind::Accept).await;
    assert_eq!(accept.delivery_id, DELIVERY);
    send(
        &mut server,
        &AcceptedFrame {
            delivery_id: DELIVERY.into(),
            secret: "the-secret".into(),
            accepted_frame_type: AcceptedFrameType::Accepted,
        },
    )
    .await;
    let report: ReportFrame = receive_as(&mut server, RunnerFrameKind::Report).await;
    assert_eq!((report.delivery_id.as_str(), report.secret.as_str()), (DELIVERY, "the-secret"));
    assert_eq!((report.outcome.ok.as_deref(), report.outcome.err), (Some("done"), None));
    assert_eq!(invoked.lock().unwrap()[0].job_name, "nightly");

    // Tron's answer is held back: stop must not return before it arrives.
    let stopping = tokio::spawn(runner.stop());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!stopping.is_finished());
    send(
        &mut server,
        &ReportRecordedFrame {
            delivery_id: DELIVERY.into(),
            late: false,
            report_recorded_frame_type: ReportRecordedEventType::ReportRecorded,
        },
    )
    .await;
    stopping.await.unwrap();
    assert!(matches!(next_event(&mut events).await, Event::DeliveryAccepted { .. }));
    assert!(matches!(next_event(&mut events).await, Event::ReportRecorded { late: false, .. }));
    assert!(
        store.pending().await.unwrap().is_empty(),
        "a recorded report deletes the stored secret"
    );
}

#[tokio::test]
async fn an_err_outcome_is_reported_as_err() {
    let (listener, endpoint) = listen().await;
    let directory = tempfile::tempdir().unwrap();
    let runner = tokio::spawn(
        Runner::builder(endpoint, "token")
            .secret_store(FileSecretStore::new(directory.path()).unwrap())
            .on("h", |_| async { Err("it broke".to_owned()) })
            .connect(),
    );
    let (mut server, _) = welcome(&listener).await;
    let _runner = runner.await.unwrap().unwrap();
    send(&mut server, &work()).await;
    receive_as::<AcceptFrame>(&mut server, RunnerFrameKind::Accept).await;
    send(
        &mut server,
        &AcceptedFrame {
            delivery_id: DELIVERY.into(),
            secret: "s".into(),
            accepted_frame_type: AcceptedFrameType::Accepted,
        },
    )
    .await;
    let report: ReportFrame = receive_as(&mut server, RunnerFrameKind::Report).await;
    assert_eq!((report.outcome.ok, report.outcome.err.as_deref()), (None, Some("it broke")));
}

#[tokio::test]
async fn a_refused_accept_is_a_typed_event_and_the_handler_does_not_run() {
    let (listener, endpoint) = listen().await;
    let directory = tempfile::tempdir().unwrap();
    let (callback, mut events) = events();
    let ran = Arc::new(Mutex::new(false));
    let flag = Arc::clone(&ran);
    let runner = tokio::spawn(
        Runner::builder(endpoint, "token")
            .secret_store(FileSecretStore::new(directory.path()).unwrap())
            .on_event(callback)
            .on("h", move |_| {
                *flag.lock().unwrap() = true;
                async { Ok(String::new()) }
            })
            .connect(),
    );
    let (mut server, _) = welcome(&listener).await;
    let runner = runner.await.unwrap().unwrap();
    next_event(&mut events).await;
    send(&mut server, &work()).await;
    receive_as::<AcceptFrame>(&mut server, RunnerFrameKind::Accept).await;
    send(
        &mut server,
        &AcceptRefusedFrame {
            delivery_id: DELIVERY.into(),
            reason: AcceptRefusal::DeliveryTimedOut,
            accept_refused_frame_type: AcceptRefusedEventType::AcceptRefused,
        },
    )
    .await;
    match next_event(&mut events).await {
        Event::Error(Error::AcceptRefused { delivery_id, reason }) => {
            assert_eq!((delivery_id.as_str(), reason), (DELIVERY, AcceptRefusal::DeliveryTimedOut))
        }
        other => panic!("expected a typed refusal, got {other:?}"),
    }
    runner.stop().await;
    assert!(!*ran.lock().unwrap());
}

#[tokio::test]
async fn reconnects_with_a_fresh_session_after_the_connection_drops() {
    let (listener, endpoint) = listen().await;
    let (callback, mut events) = events();
    let runner = tokio::spawn(
        Runner::builder(endpoint, "token")
            .backoff(Backoff {
                initial: Duration::from_millis(10),
                max: Duration::from_millis(50),
            })
            .on_event(callback)
            .on("h", |_| async { Ok(String::new()) })
            .secret_store(FileSecretStore::new(tempfile::tempdir().unwrap().keep()).unwrap())
            .connect(),
    );
    let (mut first, _) = welcome(&listener).await;
    let runner = runner.await.unwrap().unwrap();
    assert!(matches!(next_event(&mut events).await, Event::Connected { .. }));
    first.close(None).await.unwrap();
    drop(first);
    assert!(matches!(next_event(&mut events).await, Event::Disconnected));
    let (_second, announce) = welcome(&listener).await;
    assert_eq!(announce.announcement.handler_keys, ["h"]);
    assert!(matches!(next_event(&mut events).await, Event::Connected { .. }));
    runner.stop().await;
}

#[tokio::test]
async fn several_handlers_cannot_be_routed_so_the_delivery_is_not_accepted() {
    let (listener, endpoint) = listen().await;
    let (callback, mut events) = events();
    let runner = tokio::spawn(
        Runner::builder(endpoint, "token")
            .on_event(callback)
            .on("a", |_| async { Ok(String::new()) })
            .on("b", |_| async { Ok(String::new()) })
            .secret_store(FileSecretStore::new(tempfile::tempdir().unwrap().keep()).unwrap())
            .connect(),
    );
    let (mut server, announce) = welcome(&listener).await;
    let runner = runner.await.unwrap().unwrap();
    assert_eq!(announce.announcement.handler_keys, ["a", "b"]);
    next_event(&mut events).await;
    send(&mut server, &work()).await;
    assert!(matches!(
        next_event(&mut events).await,
        Event::Error(Error::UnroutableDelivery { handler_count: 2, .. })
    ));
    runner.stop().await;
}
