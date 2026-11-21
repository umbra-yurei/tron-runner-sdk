# cruma-tron-runner

The Rust runner SDK for [Tron](https://github.com/umbra-yurei/tron): connect a worker to Tron, receive the jobs it
schedules, and report each result. It is a thin client over Tron's published runner protocol (an AsyncAPI document);
every protocol message is a type generated from that document, and the SDK speaks exactly protocol version
`cruma_tron_runner::PROTOCOL_VERSION` (`v1`).

<!-- tron-runner-example:start -->
```rust
use cruma_tron_runner::{Endpoint, FileSecretStore, Runner};

let endpoint = Endpoint::from_base_url(&std::env::var("TRON_URL")?)?;
let runner = Runner::builder(endpoint, std::env::var("TRON_WORKER_KEY")?)
    .secret_store(FileSecretStore::new(std::env::var("TRON_SECRET_DIR")?)?)
    .on("send-report", |job| async move {
        // Ok marks the run succeeded and Err marks it failed; both carry a message.
        Ok(format!("sent the report for {}", job.job_name))
    })
    .connect()
    .await?;

// ... keep the process alive; when it is told to shut down:
// finish in-flight work, report it, then close
runner.stop().await;
```
<!-- tron-runner-example:end -->

## What it does

- **Connects and authenticates** with a worker API key. A rejected key is `Error::AuthenticationFailed`, an unreachable
  Tron is `Error::Unreachable`, a rejected announcement is `Error::AnnouncementRejected`; none is retried, and
  `connect()` returns them to you. Once connected, a lost connection is re-established with exponential backoff
  (100 ms doubling to 5 s, see `RunnerBuilder::backoff`) and a fresh authenticate and announce.
- **Announces** the handler keys you registered with `on`, the concurrency capacity, an optional display name and runner
  version, the SDK version and the protocol version. Tron only sends a job to a runner that announced its handler key.
- **Accepts immediately.** The moment a delivery arrives the SDK accepts it, before your handler runs, so the delivery
  deadline is met. A refused accept is `Error::AcceptRefused` carrying the generated `AcceptRefusal`, and the handler is
  not run.
- **Persists the delivery secret** Tron returns on acceptance in a `SecretStore` *before* your handler runs. The default is
  `FileSecretStore` (one `0600` file per delivery); implement `SecretStore` to keep secrets in a database or a secret manager.
  After a restart, `Runner::pending_deliveries` lists accepted deliveries that were never reported and `Runner::report`
  reports them.
- **Reports once** with that secret: `Ok(message)` or `Err(message)`. A recorded report removes the secret; a rejected report
  is `Error::ReportRejected` carrying the generated `ReportRejection`, is not retried, and keeps the secret.
- **Drains on `stop`:** takes no new work, waits for running handlers and for Tron to answer their reports, closes the connection.

Things that happen without a caller to return to, such as a refused accept or a rejected report, arrive through
`RunnerBuilder::on_event` as `Event::Error`, in order with `Connected`, `DeliveryAccepted` and `ReportRecorded`.

Retrying failed deliveries, and enforcing the capacity you announce, are Tron's job; the SDK does neither.

### Routing by handler key

Each `work` frame names the handler key it was dispatched for, and the SDK invokes the handler registered under that key
with `Job::handler_key` set from the frame. A delivery whose key has no registered handler is not accepted and surfaces
as `Event::Error(Error::UnknownHandler { delivery_id, handler_key })`. Routing by key needs a Tron whose `work` frames
carry the key.

## Development

The files under `src/generated/` are emitted from the repository's `protocol/asyncapi.json` by `npm run generate`; do not
edit them. `cargo test` runs the unit and mock-Tron tests. The shared conformance suite drives
`conformance-adapter/` against a real Tron (`npm run conformance -- --adapter rust` from the repository root, after
`cargo build -p cruma-tron-runner-conformance-adapter` in this directory).

Licensed under the MIT license.
