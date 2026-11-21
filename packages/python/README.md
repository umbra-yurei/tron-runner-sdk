# cruma-tron-runner

Run [Tron](https://github.com/umbra-yurei/tron) jobs on your own machines. Tron pushes work to a connected runner;
the runner accepts it immediately, runs your async handler, and reports `Ok(...)` or `Err(...)`.

```sh
pip install cruma-tron-runner
```

Python 3.11 or newer. The only dependency is [`websockets`](https://websockets.readthedocs.io).

<!-- tron-runner-example:start -->
```python
import os

from tron_runner import Delivery, FileSecretStore, Ok, Outcome, Runner

runner = Runner(
    os.environ["TRON_URL"],
    os.environ["TRON_WORKER_KEY"],
    secret_store=FileSecretStore(os.environ["TRON_SECRET_DIR"]),
)

async def send_report(delivery: Delivery) -> Outcome:
    # Ok marks the run succeeded and Err marks it failed; both carry a message.
    return Ok(f"sent the report for {delivery.job_name}")

runner.register("send-report", send_report)
async with runner:
    ...  # keep the process alive; leaving this block finishes in-flight work, reports it, then closes
```
<!-- tron-runner-example:end -->

## What the SDK does

- **Connects and authenticates** with the worker API key. A bad key raises `AuthenticationFailedError`; a first
  attempt that cannot reach Tron raises `UnreachableError` (both are `ConnectError`s carrying the generated
  `ConnectFailure` reason, and neither is retried). Once connected, a lost connection is re-established
  automatically with exponential backoff (100 ms, doubling, capped at 5 s) and a fresh authenticate and announce.
- **Announces** the registered handler keys, `concurrency_capacity`, optional `display_name` and `runner_version`,
  the SDK version and the protocol version. A refused announcement raises `AnnouncementRejectedError`.
- **Accepts automatically** when work arrives, then persists the one-time delivery secret *before* running the
  handler. A refused accept (`AcceptRefusedError`, with the generated `AcceptRefusal` reason) means the handler was not run.
- **Reports once** with the stored secret. Returning `Ok(message)` or `Err(message)` is the report; an exception
  from the handler is reported as `Err`. The report may go out on a later connection than the one that accepted.
  A rejected report raises `ReportRejectedError` (generated `ReportRejection` reason) and keeps the stored secret.
- **Shuts down gracefully:** `await runner.stop()` takes no new work, waits for in-flight handlers and Tron's answer
  to their reports, then disconnects.

Errors Tron raises while the runner works in the background are passed to the `on_error` callback (or logged).
`on_connected`, `on_delivery_accepted` and `on_report_recorded` observe the lifecycle.

### Secrets and restarts

The delivery secret is shown once and `report` must echo it, so it is the only state that survives a restart.
`FileSecretStore` keeps one `0600` file per delivery in a directory you choose. Implement the `SecretStore`
protocol (`save`, `load`, `remove`, `pending`) to keep secrets in a database or secret manager instead.
After a restart, `await runner.pending()` lists deliveries accepted but not yet reported and
`await runner.report_pending(delivery_id, Ok("..."))` reports one.

### Several handlers per runner

A runner can register any number of handlers. Each `work` frame names the handler key it was dispatched for, and
the runner runs the handler registered under that key. A delivery for a key with no registered handler is not
accepted and is passed to `on_error` as `UnknownHandlerError` (with `delivery_id` and `handler_key`).
Multi-handler routing needs a Tron whose `work` frame carries `handler_key`.

## Protocol messages are generated

`tron_runner.generated.protocol` is emitted from Tron's published AsyncAPI document by the repository's
`npm run generate`; nothing in this package hand-writes a frame. `tron_runner.PROTOCOL_VERSION` is the protocol
version this release speaks. CI fails if the generated files are stale (`npm run check:generated`) or if the SDK
does not decode every frame the document defines (importing `tron_runner` checks that against the generated
`ServerFrameKind`).

MIT licensed.
