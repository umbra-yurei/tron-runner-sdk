# cruma-tron-runner

Run [Tron](https://github.com/umbra-yurei/tron) jobs on your own machines. Tron pushes work to a connected runner;
the runner accepts it immediately, runs your async handler, and reports `Ok(...)` or `Err(...)`.

```sh
pip install cruma-tron-runner
```

Python 3.11 or newer. The only dependency is [`websockets`](https://websockets.readthedocs.io).

```python
import asyncio
from tron_runner import Delivery, FileSecretStore, Ok, Outcome, Runner

runner = Runner(
    "https://tron.example.com",           # the Tron base URL
    "<worker API key token>",             # created on Tron's Runners page
    secret_store=FileSecretStore("/var/lib/my-runner/secrets"),
    concurrency_capacity=4,
    display_name="build box",
)


@runner.handler("send-report")            # the handler key a job targets
async def send_report(delivery: Delivery) -> Outcome:
    return Ok(f"sent for {delivery.job_name}")


asyncio.run(runner.run())
```

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

### One handler per runner, for now

In protocol `v1` a `work` frame does not carry the handler key it was dispatched for, so a runner with several
handlers cannot route a delivery. Such a delivery is not accepted and is passed to `on_error` as
`UnroutableDeliveryError`. Register one handler per runner process until Tron adds the key to `work`.

## Protocol messages are generated

`tron_runner.generated.protocol` is emitted from Tron's published AsyncAPI document by the repository's
`npm run generate`; nothing in this package hand-writes a frame. `tron_runner.PROTOCOL_VERSION` is the protocol
version this release speaks, and CI fails if the generated files are stale or the SDK does not decode every
frame the document defines.

MIT licensed.
