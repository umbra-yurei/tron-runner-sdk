use crate::protocol::{AcceptRefusal, ProtocolViolation, ReportRejection};

/// Everything that can go wrong, as a closed set. A refusal from Tron is carried as the generated
/// enum from the published protocol, never as text.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The runner channel could not be reached. Returned to the caller on the first connection attempt;
    /// after that the runner reconnects on its own.
    #[error("Tron is unreachable: {0}")]
    Unreachable(String),
    /// Tron rejected the worker API key. Not retried.
    #[error("Tron rejected the worker API key")]
    AuthenticationFailed,
    /// Tron rejected the announcement of this runner's handlers and capacity. Not retried.
    #[error("Tron rejected the runner announcement: {0:?}")]
    AnnouncementRejected(ProtocolViolation),
    /// Tron refused to take a delivery on `accept`. The handler was not run.
    #[error("Tron refused to accept delivery {delivery_id}: {reason:?}")]
    AcceptRefused {
        /// The refused delivery.
        delivery_id: String,
        /// Why Tron refused.
        reason: AcceptRefusal,
    },
    /// Tron rejected a `report`. It is not retried and the stored delivery secret is kept.
    #[error("Tron rejected the report for delivery {delivery_id}: {reason:?}")]
    ReportRejected {
        /// The delivery whose report was rejected.
        delivery_id: String,
        /// Why Tron rejected the report.
        reason: ReportRejection,
    },
    /// Tron reported a protocol violation on an established connection.
    #[error("Tron reported a protocol violation: {0:?}")]
    ProtocolViolation(ProtocolViolation),
    /// A frame from Tron did not decode against the generated protocol bindings.
    #[error("undecodable frame from Tron: {0}")]
    Undecodable(String),
    /// Tron sent a frame that makes no sense in the current state, such as `accepted` for a delivery that was never taken.
    #[error("unexpected frame from Tron: {0}")]
    UnexpectedFrame(String),
    /// A `work` frame named a handler key that no handler is registered for. The delivery is not accepted.
    #[error("cannot route delivery {delivery_id}: no handler is registered for key {handler_key:?}")]
    UnknownHandler {
        /// The delivery that was not accepted.
        delivery_id: String,
        /// The handler key the delivery named.
        handler_key: String,
    },
    /// The secret store failed.
    #[error("secret store failed: {0}")]
    SecretStore(#[from] crate::SecretStoreError),
    /// A report was requested for a delivery with no stored secret.
    #[error("no stored secret for delivery {0}")]
    NoStoredSecret(String),
    /// The runner is misconfigured.
    #[error("invalid runner configuration: {0}")]
    Configuration(String),
    /// The runner has stopped, or ended after an error that was not retryable.
    #[error("the runner has stopped")]
    Stopped,
}
