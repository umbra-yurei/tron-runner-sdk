//! The smallest program that exposes `cruma-tron-runner` to the conformance suite: JSON commands on
//! stdin, JSON events on stdout (conformance/README.md). Every message is a generated type; the SDK
//! is driven only through its public API.
use async_trait::async_trait;
use cruma_tron_runner::{
    protocol::{
        AcceptRefusedEvent, AcceptRefusedEventType, AdapterCommandKind, AdapterCommandTag, AdapterErrorEvent, AdapterErrorEventType,
        ConnectFailedEvent, ConnectFailedEventType, ConnectFailure, ConnectedEvent, ConnectedEventType, DeliveryAcceptedEvent,
        DeliveryAcceptedEventType, HandlerInvokedEvent, HandlerInvokedEventType, HandlerOutcomeKind, ListPendingCommand, PendingEvent,
        PendingEventType, ReadyEvent, ReadyEventType, ReportPendingCommand, ReportRecordedEvent, ReportRecordedEventType,
        ReportRejectedEvent, ReportRejectedEventType, SecretStoreKind, StartCommand, StoppedEvent, StoppedEventType,
    },
    Endpoint, Error, Event, FileSecretStore, Runner, SecretStore, SecretStoreError, SDK_VERSION, SUPPORTED_PROTOCOL,
};
use serde::Serialize;
use std::{io::Write, process::ExitCode, sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};

fn emit<T: Serialize>(event: &T) {
    let mut line = serde_json::to_string(event).expect("generated events always serialize");
    line.push('\n');
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(line.as_bytes()).and_then(|()| stdout.flush());
}

fn fail(message: impl ToString) {
    emit(&AdapterErrorEvent {
        message: message.to_string(),
        adapter_error_event_type: AdapterErrorEventType::Error,
    });
}

const TAMPER_SUFFIX: &str = "-tampered";

/// Returns a wrong secret from `load`, so Tron rejects the report.
struct Tampered(FileSecretStore);

#[async_trait]
impl SecretStore for Tampered {
    async fn save(&self, delivery_id: &str, secret: &str) -> Result<(), SecretStoreError> {
        self.0.save(delivery_id, secret).await
    }
    async fn load(&self, delivery_id: &str) -> Result<Option<String>, SecretStoreError> {
        Ok(self.0.load(delivery_id).await?.map(|secret| secret + TAMPER_SUFFIX))
    }
    async fn remove(&self, delivery_id: &str) -> Result<(), SecretStoreError> {
        self.0.remove(delivery_id).await
    }
    async fn pending(&self) -> Result<Vec<String>, SecretStoreError> {
        self.0.pending().await
    }
}

/// Never forgets a secret, so a finished delivery can be reported a second time.
struct Retaining(FileSecretStore);

#[async_trait]
impl SecretStore for Retaining {
    async fn save(&self, delivery_id: &str, secret: &str) -> Result<(), SecretStoreError> {
        self.0.save(delivery_id, secret).await
    }
    async fn load(&self, delivery_id: &str) -> Result<Option<String>, SecretStoreError> {
        self.0.load(delivery_id).await
    }
    async fn remove(&self, _delivery_id: &str) -> Result<(), SecretStoreError> {
        Ok(())
    }
    async fn pending(&self) -> Result<Vec<String>, SecretStoreError> {
        self.0.pending().await
    }
}

fn on_event(event: Event) {
    match event {
        Event::Connected { session_id } => emit(&ConnectedEvent {
            session_id,
            connected_event_type: ConnectedEventType::Connected,
        }),
        Event::Disconnected => {}
        Event::DeliveryAccepted { delivery_id } => emit(&DeliveryAcceptedEvent {
            delivery_id,
            delivery_accepted_event_type: DeliveryAcceptedEventType::DeliveryAccepted,
        }),
        Event::ReportRecorded { delivery_id, late } => emit(&ReportRecordedEvent {
            delivery_id,
            late,
            report_recorded_event_type: ReportRecordedEventType::ReportRecorded,
        }),
        Event::Error(Error::AcceptRefused { delivery_id, reason }) => emit(&AcceptRefusedEvent {
            delivery_id,
            reason,
            accept_refused_event_type: AcceptRefusedEventType::AcceptRefused,
        }),
        Event::Error(Error::ReportRejected { delivery_id, reason }) => emit(&ReportRejectedEvent {
            delivery_id,
            reason,
            report_rejected_event_type: ReportRejectedEventType::ReportRejected,
        }),
        Event::Error(error) => fail(error),
    }
}

async fn start(command: StartCommand) -> Result<Runner, ()> {
    let endpoint = Endpoint::from_websocket_url(&command.tron_url).map_err(fail)?;
    let files = FileSecretStore::new(&command.secret_store.directory).map_err(fail)?;
    let mut builder = Runner::builder(endpoint, command.token)
        .concurrency_capacity(command.concurrency_capacity.max(1) as u32)
        .on_event(on_event);
    if let Some(name) = command.display_name {
        builder = builder.display_name(name);
    }
    if let Some(version) = command.runner_version {
        builder = builder.runner_version(version);
    }
    builder = match command.secret_store.kind {
        SecretStoreKind::File => builder.secret_store(files),
        SecretStoreKind::Tampered => builder.secret_store(Tampered(files)),
        SecretStoreKind::Retaining => builder.secret_store(Retaining(files)),
    };
    for script in command.handlers {
        let script = Arc::new(script);
        builder = builder.on(script.handler_key.clone(), move |job| {
            let script = Arc::clone(&script);
            async move {
                emit(&HandlerInvokedEvent {
                    handler_key: job.handler_key,
                    delivery_id: job.delivery_id,
                    run_id: job.run_id,
                    job_id: job.job_id,
                    job_name: job.job_name,
                    handler_invoked_event_type: HandlerInvokedEventType::HandlerInvoked,
                });
                tokio::time::sleep(Duration::from_millis(script.delay_ms.max(0) as u64)).await;
                match script.outcome {
                    HandlerOutcomeKind::ReplyOk => Ok(script.message.clone()),
                    HandlerOutcomeKind::ReplyErr => Err(script.message.clone()),
                }
            }
        });
    }
    match builder.connect().await {
        Ok(runner) => Ok(runner),
        Err(error) => {
            let reason = match error {
                Error::Unreachable(_) => ConnectFailure::Unreachable,
                Error::AuthenticationFailed => ConnectFailure::AuthenticationFailed,
                Error::AnnouncementRejected(_) => ConnectFailure::AnnouncementRejected,
                other => {
                    fail(other);
                    return Err(());
                }
            };
            emit(&ConnectFailedEvent {
                reason,
                connect_failed_event_type: ConnectFailedEventType::ConnectFailed,
            });
            Err(())
        }
    }
}

fn require(runner: &Option<Runner>) -> Result<&Runner, ()> {
    runner.as_ref().ok_or_else(|| fail("no start command was received"))
}

fn parse<T: serde::de::DeserializeOwned>(line: &str) -> Result<T, ()> {
    serde_json::from_str(line).map_err(fail)
}

#[tokio::main]
async fn main() -> ExitCode {
    emit(&ReadyEvent {
        protocol_version: SUPPORTED_PROTOCOL,
        sdk_version: SDK_VERSION.to_owned(),
        ready_event_type: ReadyEventType::Ready,
    });
    let mut runner: Option<Runner> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(tag) = parse::<AdapterCommandTag>(&line) else { continue };
        match tag.adapter_command_tag_type {
            AdapterCommandKind::Start => {
                if let Ok(command) = parse::<StartCommand>(&line) {
                    // A failed start has already been reported as `connect_failed` or `error`.
                    runner = start(command).await.ok();
                }
            }
            AdapterCommandKind::ReportPending => {
                let (Ok(command), Ok(runner)) = (parse::<ReportPendingCommand>(&line), require(&runner)) else {
                    continue;
                };
                let result = match (command.outcome.ok, command.outcome.err) {
                    (Some(message), None) => Ok(message),
                    (None, Some(message)) => Err(message),
                    _ => {
                        fail("an outcome is exactly one of ok and err");
                        continue;
                    }
                };
                if let Err(error) = runner.report(&command.delivery_id, result).await {
                    fail(error);
                }
            }
            AdapterCommandKind::ListPending => {
                let (Ok(_), Ok(runner)) = (parse::<ListPendingCommand>(&line), require(&runner)) else {
                    continue;
                };
                match runner.pending_deliveries().await {
                    Ok(delivery_ids) => emit(&PendingEvent {
                        delivery_ids,
                        pending_event_type: PendingEventType::Pending,
                    }),
                    Err(error) => fail(error),
                }
            }
            AdapterCommandKind::Stop => {
                if let Some(runner) = runner.take() {
                    runner.stop().await;
                }
                emit(&StoppedEvent {
                    stopped_event_type: StoppedEventType::Stopped,
                });
                return ExitCode::SUCCESS;
            }
        }
    }
    ExitCode::SUCCESS
}
