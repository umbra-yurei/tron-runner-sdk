use crate::{
    protocol::{
        AcceptFrame, AcceptFrameType, AcceptedFrame, AnnounceFrame, AnnounceFrameType, AuthenticateFrame, AuthenticateFrameType,
        ProtocolViolation, ServerFrameKind, ServerFrameTag, WorkFrame,
    },
    runner::{report_frame, Config, Event, Job, JobResult},
    Error,
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) enum Message {
    Report { delivery_id: String, result: JobResult },
    HandlerDone { delivery_id: String, result: JobResult },
    Stop { done: Option<oneshot::Sender<()>> },
}

pub(crate) struct Established {
    socket: Socket,
    session_id: String,
    /// Frames Tron sent between `authenticated` and `announced`; they are processed first.
    early: Vec<String>,
}

enum HandshakeError {
    Transport(String),
    AuthenticationFailed,
    AnnouncementRejected(ProtocolViolation),
}

impl From<HandshakeError> for Error {
    fn from(error: HandshakeError) -> Self {
        match error {
            HandshakeError::Transport(reason) => Error::Unreachable(reason),
            HandshakeError::AuthenticationFailed => Error::AuthenticationFailed,
            HandshakeError::AnnouncementRejected(reason) => Error::AnnouncementRejected(reason),
        }
    }
}

enum Frame {
    Authenticated(crate::protocol::AuthenticatedFrame),
    Announced,
    AuthenticationFailed,
    Work(WorkFrame),
    Accepted(AcceptedFrame),
    AcceptRefused(crate::protocol::AcceptRefusedFrame),
    ReportRecorded(crate::protocol::ReportRecordedFrame),
    ReportRejected(crate::protocol::ReportRejectedFrame),
    ProtocolError(crate::protocol::ProtocolErrorFrame),
}

/// Reads only the `type` tag, then decodes the frame that tag names with its generated type.
fn decode(text: &str) -> Result<Frame, Error> {
    fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, Error> {
        serde_json::from_str(text).map_err(|error| Error::Undecodable(error.to_string()))
    }
    Ok(match parse::<ServerFrameTag>(text)?.server_frame_tag_type {
        ServerFrameKind::Authenticated => Frame::Authenticated(parse(text)?),
        ServerFrameKind::Announced => Frame::Announced,
        ServerFrameKind::AuthenticationFailed => Frame::AuthenticationFailed,
        ServerFrameKind::Work => Frame::Work(parse(text)?),
        ServerFrameKind::Accepted => Frame::Accepted(parse(text)?),
        ServerFrameKind::AcceptRefused => Frame::AcceptRefused(parse(text)?),
        ServerFrameKind::ReportRecorded => Frame::ReportRecorded(parse(text)?),
        ServerFrameKind::ReportRejected => Frame::ReportRejected(parse(text)?),
        ServerFrameKind::ProtocolError => Frame::ProtocolError(parse(text)?),
    })
}

fn encode<T: serde::Serialize>(frame: &T) -> WsMessage {
    WsMessage::text(serde_json::to_string(frame).expect("generated frames always serialize"))
}

/// The next text frame, or `None` when the connection ended.
async fn next_text(socket: &mut Socket) -> Option<String> {
    loop {
        match socket.next().await? {
            Ok(WsMessage::Text(text)) => return Some(text.as_str().to_owned()),
            Ok(WsMessage::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

/// Connects, authenticates and announces. One attempt, bounded by the configured connect timeout.
pub(crate) async fn handshake(config: &Config) -> Result<Established, Error> {
    attempt(config).await.map_err(Error::from)
}

async fn attempt(config: &Config) -> Result<Established, HandshakeError> {
    match tokio::time::timeout(config.connect_timeout, exchange(config)).await {
        Ok(result) => result,
        Err(_) => Err(HandshakeError::Transport("timed out connecting to Tron".into())),
    }
}

async fn exchange(config: &Config) -> Result<Established, HandshakeError> {
    let transport = |error: &dyn std::fmt::Display| HandshakeError::Transport(error.to_string());
    let (mut socket, _) = connect_async(config.endpoint.websocket_url())
        .await
        .map_err(|error| transport(&error))?;
    let authenticate = AuthenticateFrame {
        token: config.token.clone(),
        authenticate_frame_type: AuthenticateFrameType::Authenticate,
    };
    socket.send(encode(&authenticate)).await.map_err(|error| transport(&error))?;
    let mut session_id = None;
    let mut early = Vec::new();
    loop {
        let text = next_text(&mut socket)
            .await
            .ok_or_else(|| HandshakeError::Transport("connection closed during the handshake".into()))?;
        match decode(&text) {
            Ok(Frame::Authenticated(frame)) => {
                session_id = Some(frame.session_id);
                let announce = AnnounceFrame {
                    announcement: config.announcement.clone(),
                    announce_frame_type: AnnounceFrameType::Announce,
                };
                socket.send(encode(&announce)).await.map_err(|error| transport(&error))?;
            }
            Ok(Frame::Announced) => {
                let session_id =
                    session_id.ok_or_else(|| HandshakeError::Transport("Tron announced a session that was never authenticated".into()))?;
                return Ok(Established { socket, session_id, early });
            }
            Ok(Frame::AuthenticationFailed) => return Err(HandshakeError::AuthenticationFailed),
            Ok(Frame::ProtocolError(frame)) => return Err(HandshakeError::AnnouncementRejected(frame.reason)),
            Ok(_) => early.push(text),
            Err(error) => return Err(transport(&error)),
        }
    }
}

enum Served {
    Finished,
    Lost,
}

/// The task that owns the connection and everything in flight on it.
pub(crate) struct Actor {
    config: Arc<Config>,
    control: mpsc::UnboundedSender<Message>,
    messages: mpsc::UnboundedReceiver<Message>,
    stopping: bool,
    done: Vec<oneshot::Sender<()>>,
    /// Deliveries whose `accept` was sent on the current connection and not yet answered.
    awaiting_accept: HashMap<String, Job>,
    /// Handlers currently running.
    running: usize,
    /// Results waiting for Tron to answer their report, from the moment the handler finishes.
    outstanding: BTreeMap<String, JobResult>,
    /// Outstanding reports already sent on the current connection.
    sent: BTreeSet<String>,
}

impl Actor {
    pub(crate) fn new(config: Arc<Config>, control: mpsc::UnboundedSender<Message>, messages: mpsc::UnboundedReceiver<Message>) -> Self {
        Self {
            config,
            control,
            messages,
            stopping: false,
            done: Vec::new(),
            awaiting_accept: HashMap::new(),
            running: 0,
            outstanding: BTreeMap::new(),
            sent: BTreeSet::new(),
        }
    }

    pub(crate) async fn run(mut self, first: Established) {
        let mut next = Some(first);
        loop {
            let established = match next.take() {
                Some(established) => established,
                None => match self.reconnect().await {
                    Some(established) => established,
                    None => break,
                },
            };
            match self.serve(established).await {
                Served::Finished => break,
                Served::Lost => {
                    self.awaiting_accept.clear();
                    self.sent.clear();
                    self.emit(Event::Disconnected);
                }
            }
        }
        for waiter in self.done.drain(..) {
            let _ = waiter.send(());
        }
    }

    fn emit(&self, event: Event) {
        if let Event::Error(error) = &event {
            log::warn!("tron runner: {error}");
        }
        (self.config.on_event)(event);
    }

    fn fail(&self, error: Error) {
        self.emit(Event::Error(error));
    }

    fn drained(&self) -> bool {
        self.awaiting_accept.is_empty() && self.running == 0 && self.outstanding.is_empty()
    }

    fn finished(&self) -> bool {
        self.stopping && self.drained()
    }

    fn on_message(&mut self, message: Message) {
        match message {
            Message::Report { delivery_id, result } => {
                self.outstanding.entry(delivery_id).or_insert(result);
            }
            Message::HandlerDone { delivery_id, result } => {
                self.running -= 1;
                self.outstanding.insert(delivery_id, result);
            }
            Message::Stop { done } => {
                self.stopping = true;
                self.done.extend(done);
            }
        }
    }

    /// Waits out the backoff and retries until a connection is established, or returns `None` when the runner is
    /// finished, or when Tron rejects the key or the announcement (not retried).
    async fn reconnect(&mut self) -> Option<Established> {
        let backoff = self.config.backoff;
        let mut delay = backoff.initial;
        loop {
            let pause = tokio::time::sleep(delay);
            tokio::pin!(pause);
            loop {
                if self.finished() {
                    return None;
                }
                tokio::select! {
                    () = &mut pause => break,
                    message = self.messages.recv() => self.on_message(message?),
                }
            }
            let config = Arc::clone(&self.config);
            let connecting = attempt(&config);
            tokio::pin!(connecting);
            let outcome = loop {
                tokio::select! {
                    outcome = &mut connecting => break outcome,
                    message = self.messages.recv() => self.on_message(message?),
                }
            };
            match outcome {
                Ok(established) => return Some(established),
                Err(HandshakeError::Transport(reason)) => {
                    log::debug!("tron runner: reconnect failed: {reason}");
                    delay = (delay * 2).min(backoff.max);
                }
                Err(fatal) => {
                    self.fail(Error::from(fatal));
                    return None;
                }
            }
        }
    }

    async fn serve(&mut self, established: Established) -> Served {
        let Established {
            mut socket,
            session_id,
            early,
        } = established;
        self.emit(Event::Connected { session_id });
        for text in early {
            if self.on_frame(&mut socket, &text).await.is_err() {
                return Served::Lost;
            }
        }
        loop {
            if self.flush_reports(&mut socket).await.is_err() {
                return Served::Lost;
            }
            if self.finished() {
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                return Served::Finished;
            }
            tokio::select! {
                frame = next_text(&mut socket) => match frame {
                    None => return Served::Lost,
                    Some(text) => {
                        if self.on_frame(&mut socket, &text).await.is_err() {
                            return Served::Lost;
                        }
                    }
                },
                message = self.messages.recv() => match message {
                    Some(message) => self.on_message(message),
                    None => return Served::Finished,
                },
            }
        }
    }

    async fn flush_reports(&mut self, socket: &mut Socket) -> Result<(), ()> {
        let unsent: Vec<String> = self.outstanding.keys().filter(|id| !self.sent.contains(*id)).cloned().collect();
        for delivery_id in unsent {
            let secret = match self.config.store.load(&delivery_id).await {
                Ok(Some(secret)) => secret,
                Ok(None) => {
                    self.outstanding.remove(&delivery_id);
                    self.fail(Error::NoStoredSecret(delivery_id));
                    continue;
                }
                Err(error) => {
                    self.outstanding.remove(&delivery_id);
                    self.fail(Error::SecretStore(error));
                    continue;
                }
            };
            let frame = report_frame(&delivery_id, secret, &self.outstanding[&delivery_id]);
            socket.send(encode(&frame)).await.map_err(|_| ())?;
            self.sent.insert(delivery_id);
        }
        Ok(())
    }

    /// `Err` means the connection broke while answering.
    async fn on_frame(&mut self, socket: &mut Socket, text: &str) -> Result<(), ()> {
        let frame = match decode(text) {
            Ok(frame) => frame,
            Err(error) => {
                self.fail(error);
                return Ok(());
            }
        };
        match frame {
            Frame::Work(work) => return self.on_work(socket, work).await,
            Frame::Accepted(accepted) => self.on_accepted(accepted).await,
            Frame::AcceptRefused(refused) => {
                self.awaiting_accept.remove(&refused.delivery_id);
                self.fail(Error::AcceptRefused {
                    delivery_id: refused.delivery_id,
                    reason: refused.reason,
                });
            }
            Frame::ReportRecorded(recorded) => {
                if self.outstanding.remove(&recorded.delivery_id).is_some() {
                    self.sent.remove(&recorded.delivery_id);
                    if let Err(error) = self.config.store.remove(&recorded.delivery_id).await {
                        self.fail(Error::SecretStore(error));
                    }
                    self.emit(Event::ReportRecorded {
                        delivery_id: recorded.delivery_id,
                        late: recorded.late,
                    });
                }
            }
            Frame::ReportRejected(rejected) => {
                // An answer for a report that was resent after a reconnect and already settled is not news.
                if self.outstanding.remove(&rejected.delivery_id).is_some() {
                    self.sent.remove(&rejected.delivery_id);
                    self.fail(Error::ReportRejected {
                        delivery_id: rejected.delivery_id,
                        reason: rejected.reason,
                    });
                }
            }
            Frame::ProtocolError(error) => self.fail(Error::ProtocolViolation(error.reason)),
            Frame::Authenticated(_) | Frame::Announced | Frame::AuthenticationFailed => {
                self.fail(Error::UnexpectedFrame("a handshake frame on an established connection".into()));
            }
        }
        Ok(())
    }

    async fn on_work(&mut self, socket: &mut Socket, work: WorkFrame) -> Result<(), ()> {
        if self.stopping {
            log::debug!("tron runner: stopping; not accepting delivery {}", work.delivery_id);
            return Ok(());
        }
        // Protocol v1 does not say which handler a delivery is for, so only a sole handler can be routed to.
        let mut keys = self.config.handlers.keys();
        let (Some(handler_key), None) = (keys.next(), keys.next()) else {
            self.fail(Error::UnroutableDelivery {
                delivery_id: work.delivery_id,
                handler_count: self.config.handlers.len(),
            });
            return Ok(());
        };
        let job = Job {
            handler_key: handler_key.clone(),
            run_id: work.run_id,
            job_id: work.job_id,
            job_name: work.job_name,
            delivery_id: work.delivery_id.clone(),
            scheduled_for: work.scheduled_for,
            accept_deadline: work.accept_deadline,
        };
        self.awaiting_accept.insert(work.delivery_id.clone(), job);
        let accept = AcceptFrame {
            delivery_id: work.delivery_id,
            accept_frame_type: AcceptFrameType::Accept,
        };
        socket.send(encode(&accept)).await.map_err(|_| ())
    }

    async fn on_accepted(&mut self, accepted: AcceptedFrame) {
        let Some(job) = self.awaiting_accept.remove(&accepted.delivery_id) else {
            self.fail(Error::UnexpectedFrame(format!(
                "accepted for delivery {} that was never taken",
                accepted.delivery_id
            )));
            return;
        };
        // The secret is the only way to report this delivery: it is durable before the handler can run.
        if let Err(error) = self.config.store.save(&accepted.delivery_id, &accepted.secret).await {
            self.fail(Error::SecretStore(error));
            return;
        }
        self.emit(Event::DeliveryAccepted {
            delivery_id: accepted.delivery_id.clone(),
        });
        let handler = Arc::clone(&self.config.handlers[&job.handler_key]);
        let control = self.control.clone();
        self.running += 1;
        tokio::spawn(async move {
            let delivery_id = job.delivery_id.clone();
            let result = match tokio::spawn(async move { handler(job).await }).await {
                Ok(result) => result,
                Err(error) => Err(format!("handler failed: {error}")),
            };
            let _ = control.send(Message::HandlerDone { delivery_id, result });
        });
    }
}
