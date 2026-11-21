//! A thin Rust SDK for Tron runners: connect a worker to [Tron](https://github.com/umbra-yurei/tron),
//! receive the jobs it schedules over the runner protocol, and report each result.
//!
//! ```no_run
//! use cruma_tron_runner::{Endpoint, Runner};
//!
//! # async fn run() -> Result<(), cruma_tron_runner::Error> {
//! let runner = Runner::builder(Endpoint::from_base_url("https://tron.example.com")?, "worker-api-key")
//!     .display_name("nightly-worker")
//!     .on("send-report", |job| async move {
//!         // `Ok` marks the run succeeded, `Err` marks it failed; both carry a message.
//!         Ok(format!("sent the report for {}", job.job_name))
//!     })
//!     .connect()
//!     .await?;
//! // ... run until told to stop, then finish in-flight work and report it:
//! runner.stop().await;
//! # Ok(())
//! # }
//! ```
//!
//! What the SDK does for you: it authenticates, announces the handlers you registered, accepts every
//! delivery the moment it arrives (Tron refuses an accept past the delivery's deadline), saves the
//! delivery secret in a [`SecretStore`] before running your handler, reports `Ok`/`Err` with that secret,
//! reconnects with exponential backoff when the connection drops, and drains in-flight work on
//! [`Runner::stop`]. Retries of failed deliveries are Tron's job, not the SDK's.
//!
//! Protocol messages are the types in [`protocol`], generated from the AsyncAPI document Tron publishes;
//! the SDK declares exactly the protocol version in [`PROTOCOL_VERSION`].

mod endpoint;
mod error;
mod runner;
mod session;
mod store;

/// The runner protocol's message types, generated from Tron's published AsyncAPI document. Alongside the
/// wire frames this module carries the conformance suite's adapter messages, which are generated from the
/// same bundle; ordinary users only need the closed enums ([`AcceptRefusal`](protocol::AcceptRefusal),
/// [`ReportRejection`](protocol::ReportRejection), [`ProtocolViolation`](protocol::ProtocolViolation)).
#[allow(missing_docs, clippy::all, unused_qualifications)]
#[rustfmt::skip]
#[path = "generated/protocol.rs"]
pub mod protocol;
#[rustfmt::skip]
#[path = "generated/protocol_version.rs"]
mod protocol_version;

pub use endpoint::Endpoint;
pub use error::Error;
pub use protocol_version::{PROTOCOL_DOCUMENT_VERSION, PROTOCOL_VERSION, RUNNER_CHANNEL_ADDRESS};
pub use runner::{Backoff, Event, Job, JobResult, Runner, RunnerBuilder};
pub use store::{FileSecretStore, SecretStore, SecretStoreError};

/// The version of this SDK, announced to Tron.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The one runner protocol version this SDK speaks, as the generated enum. Equal to [`PROTOCOL_VERSION`].
pub const SUPPORTED_PROTOCOL: protocol::RunnerProtocolVersion = protocol::RunnerProtocolVersion::V1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_protocol_is_the_generated_protocol_version() {
        let encoded = serde_json::to_string(&SUPPORTED_PROTOCOL).unwrap();
        assert_eq!(serde_json::from_str::<String>(&encoded).unwrap(), PROTOCOL_VERSION);
    }
}
