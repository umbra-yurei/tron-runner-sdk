use crate::{
    protocol::{ReportFrame, RunnerAnnouncement},
    session::{self, Actor, Message},
    Endpoint, Error, FileSecretStore, SecretStore, SDK_VERSION, SUPPORTED_PROTOCOL,
};
use futures_util::future::BoxFuture;
use std::{collections::BTreeMap, future::Future, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

const DEFAULT_SECRET_DIRECTORY: &str = "tron-runner-secrets";

/// What a handler returns: `Ok(message)` marks the run succeeded, `Err(message)` marks it failed.
pub type JobResult = Result<String, String>;

/// A delivery of one scheduled run, handed to a handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// The key of the handler this delivery was routed to.
    pub handler_key: String,
    /// The run being delivered.
    pub run_id: String,
    /// The job the run belongs to.
    pub job_id: String,
    /// The job's name.
    pub job_name: String,
    /// This delivery of the run.
    pub delivery_id: String,
    /// When the run was scheduled for (RFC 3339).
    pub scheduled_for: String,
    /// The latest moment Tron accepts this delivery (RFC 3339). The SDK has already accepted it by the time the handler runs.
    pub accept_deadline: String,
}

/// Something that happened to the runner, reported to the callback given to [`RunnerBuilder::on_event`].
/// Events arrive in the order they happened.
#[derive(Debug)]
pub enum Event {
    /// A session was established: authenticated and announced. Sent again after every reconnect.
    Connected {
        /// Tron's id for this session.
        session_id: String,
    },
    /// The connection was lost; the runner is reconnecting with backoff.
    Disconnected,
    /// Tron accepted a delivery and its secret is saved; the handler is about to run.
    DeliveryAccepted {
        /// The accepted delivery.
        delivery_id: String,
    },
    /// Tron recorded a delivery's report and its stored secret was removed.
    ReportRecorded {
        /// The reported delivery.
        delivery_id: String,
        /// Whether Tron considered the report late.
        late: bool,
    },
    /// A typed refusal or failure that has no caller to return to: [`Error::AcceptRefused`],
    /// [`Error::ReportRejected`], [`Error::ProtocolViolation`], and the like.
    Error(Error),
}

/// How the runner paces reconnection: the first delay, doubled after each failed attempt up to a cap.
/// Reset by a successful connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    /// The delay before the first reconnection attempt.
    pub initial: Duration,
    /// The longest delay between attempts.
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_millis(100),
            max: Duration::from_secs(5),
        }
    }
}

pub(crate) type Handler = Arc<dyn Fn(Job) -> BoxFuture<'static, JobResult> + Send + Sync>;
pub(crate) type EventCallback = Arc<dyn Fn(Event) + Send + Sync>;

pub(crate) struct Config {
    pub endpoint: Endpoint,
    pub token: String,
    pub announcement: RunnerAnnouncement,
    pub handlers: BTreeMap<String, Handler>,
    pub store: Arc<dyn SecretStore>,
    pub on_event: EventCallback,
    pub backoff: Backoff,
    pub connect_timeout: Duration,
}

/// Configures and connects a [`Runner`]. Start with [`Runner::builder`].
pub struct RunnerBuilder {
    endpoint: Endpoint,
    token: String,
    handlers: Vec<(String, Handler)>,
    concurrency_capacity: i64,
    display_name: Option<String>,
    runner_version: Option<String>,
    store: Option<Arc<dyn SecretStore>>,
    on_event: EventCallback,
    backoff: Backoff,
    connect_timeout: Duration,
}

impl RunnerBuilder {
    /// Registers the handler for jobs whose handler key is `key`. The registered keys are what the runner announces:
    /// Tron only sends a job to a runner that announced its key.
    pub fn on<F, Fut>(mut self, key: impl Into<String>, handler: F) -> Self
    where
        F: Fn(Job) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = JobResult> + Send + 'static,
    {
        self.handlers.push((key.into(), Arc::new(move |job| Box::pin(handler(job)))));
        self
    }

    /// How many jobs this runner is able to run at once, announced to Tron (default 1).
    pub fn concurrency_capacity(mut self, capacity: u32) -> Self {
        self.concurrency_capacity = i64::from(capacity);
        self
    }

    /// A name for this runner in Tron's UI.
    pub fn display_name(mut self, name: impl Into<String>) -> Self {
        self.display_name = Some(name.into());
        self
    }

    /// The version of the program using the SDK, announced to Tron.
    pub fn runner_version(mut self, version: impl Into<String>) -> Self {
        self.runner_version = Some(version.into());
        self
    }

    /// Where delivery secrets are kept between accepting a delivery and reporting it. Defaults to a
    /// [`FileSecretStore`] in `tron-runner-secrets` under the current directory; pass your own store, or a
    /// `FileSecretStore` in a directory of your choosing, for anything that must survive a restart in a known place.
    pub fn secret_store(mut self, store: impl SecretStore) -> Self {
        self.store = Some(Arc::new(store));
        self
    }

    /// Receives every [`Event`]. Called on the runner's own task, so keep it quick and do not block.
    /// Errors are also logged at `warn` through the `log` facade.
    pub fn on_event(mut self, callback: impl Fn(Event) + Send + Sync + 'static) -> Self {
        self.on_event = Arc::new(callback);
        self
    }

    /// Paces reconnection (default 100 ms doubling up to 5 s).
    pub fn backoff(mut self, backoff: Backoff) -> Self {
        self.backoff = backoff;
        self
    }

    /// How long one connection attempt (TCP, WebSocket and the authenticate/announce exchange) may take (default 15 s).
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// Connects, authenticates and announces, and returns once Tron has acknowledged the announcement.
    ///
    /// Fails with [`Error::Unreachable`], [`Error::AuthenticationFailed`] or [`Error::AnnouncementRejected`]
    /// without retrying. After this returns, a lost connection is re-established by the runner itself.
    pub async fn connect(self) -> Result<Runner, Error> {
        if self.handlers.is_empty() {
            return Err(Error::Configuration("register at least one handler with `on`".into()));
        }
        let mut handlers = BTreeMap::new();
        for (key, handler) in self.handlers {
            if handlers.insert(key.clone(), handler).is_some() {
                return Err(Error::Configuration(format!("handler key `{key}` is registered twice")));
            }
        }
        let store: Arc<dyn SecretStore> = match self.store {
            Some(store) => store,
            None => Arc::new(FileSecretStore::new(DEFAULT_SECRET_DIRECTORY)?),
        };
        let announcement = RunnerAnnouncement {
            concurrency_capacity: Some(self.concurrency_capacity),
            display_name: self.display_name,
            handler_keys: handlers.keys().cloned().collect(),
            protocol_version: Some(SUPPORTED_PROTOCOL),
            runner_version: self.runner_version,
            sdk_version: Some(SDK_VERSION.to_owned()),
        };
        let config = Arc::new(Config {
            endpoint: self.endpoint,
            token: self.token,
            announcement,
            handlers,
            store,
            on_event: self.on_event,
            backoff: self.backoff,
            connect_timeout: self.connect_timeout,
        });
        let established = session::handshake(&config).await?;
        let (control, messages) = mpsc::unbounded_channel();
        let actor = Actor::new(Arc::clone(&config), control.clone(), messages);
        tokio::spawn(actor.run(established));
        Ok(Runner {
            config,
            control,
            stopped: false,
        })
    }
}

/// A connected runner. Dropping it without calling [`Runner::stop`] still drains in the background.
pub struct Runner {
    config: Arc<Config>,
    control: mpsc::UnboundedSender<Message>,
    stopped: bool,
}

impl Runner {
    /// Starts configuring a runner for `endpoint`, authenticating with the worker API key `token`.
    pub fn builder(endpoint: Endpoint, token: impl Into<String>) -> RunnerBuilder {
        RunnerBuilder {
            endpoint,
            token: token.into(),
            handlers: Vec::new(),
            concurrency_capacity: 1,
            display_name: None,
            runner_version: None,
            store: None,
            on_event: Arc::new(|_| {}),
            backoff: Backoff::default(),
            connect_timeout: Duration::from_secs(15),
        }
    }

    /// The deliveries this runner accepted and has not reported, from the secret store. After a restart these are the
    /// deliveries whose handler died with the old process.
    pub async fn pending_deliveries(&self) -> Result<Vec<String>, Error> {
        Ok(self.config.store.pending().await?)
    }

    /// Reports the result of an accepted delivery using the secret in the store, for example one found by
    /// [`Runner::pending_deliveries`] after a restart. The report may go out on a different connection than the one that accepted.
    /// Tron's answer arrives as an [`Event`].
    pub async fn report(&self, delivery_id: &str, result: JobResult) -> Result<(), Error> {
        if self.config.store.load(delivery_id).await?.is_none() {
            return Err(Error::NoStoredSecret(delivery_id.to_owned()));
        }
        self.control
            .send(Message::Report {
                delivery_id: delivery_id.to_owned(),
                result,
            })
            .map_err(|_| Error::Stopped)
    }

    /// Stops taking new work, waits for running handlers to finish and for Tron to answer their reports, closes the
    /// connection and returns.
    pub async fn stop(mut self) {
        self.stopped = true;
        let (done, finished) = oneshot::channel();
        if self.control.send(Message::Stop { done: Some(done) }).is_ok() {
            let _ = finished.await;
        }
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.control.send(Message::Stop { done: None });
        }
    }
}

pub(crate) fn report_frame(delivery_id: &str, secret: String, result: &JobResult) -> ReportFrame {
    use crate::protocol::{ReportFrameType, RunOutcome};
    let outcome = match result {
        Ok(message) => RunOutcome {
            ok: Some(message.clone()),
            err: None,
        },
        Err(message) => RunOutcome {
            ok: None,
            err: Some(message.clone()),
        },
    };
    ReportFrame {
        delivery_id: delivery_id.to_owned(),
        outcome,
        secret,
        report_frame_type: ReportFrameType::Report,
    }
}
