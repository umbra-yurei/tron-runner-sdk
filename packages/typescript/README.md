# @cruma-io/tron-runner

Runner SDK for [Tron](https://github.com/umbra-yurei/tron), the scheduling service. A runner connects with a worker
API key, announces the handlers it can run, and Tron pushes work for jobs whose handler key it announced. The SDK
accepts each delivery immediately, persists the one-time delivery secret, runs your handler and reports `Ok` or `Err`.

Needs Node 22 or newer (it uses the built-in `WebSocket`). No runtime dependencies.

```sh
npm install @cruma-io/tron-runner
```

<!-- tron-runner-example:start -->
```ts
import { FileSecretStore, ok, Runner } from "@cruma-io/tron-runner";

const runner = new Runner({
  url: process.env.TRON_URL!,
  token: process.env.TRON_WORKER_KEY!,
  secretStore: new FileSecretStore(process.env.TRON_SECRET_DIR!),
});

runner.handle("send-report", (delivery) => {
  // Ok marks the run succeeded and Err marks it failed; both carry a message.
  return ok(`sent the report for ${delivery.jobName}`);
});

await runner.start();
// ... keep the process alive; when it is told to shut down:
await runner.stop(); // finish in-flight work, report it, then close
```
<!-- tron-runner-example:end -->

## What it does

- **Connects and reconnects.** `start()` rejects with `AuthenticationFailedError`, `AnnouncementRejectedError` or
  `UnreachableError`. After a successful start a lost connection is re-established with exponential backoff (100 ms,
  doubling, capped at 5 s), authenticating and announcing again; `connected` is emitted for every new session.
- **Announces** the registered handler keys, the capacity, the optional display name and runner version, the SDK
  version and the protocol version it was generated for (`PROTOCOL_VERSION`).
- **Accepts on delivery**, before running the handler, so the accept deadline is met. A refusal is an
  `AcceptRefusedError` (with the closed `reason`) on the `error` event and the handler is not run.
- **Persists the delivery secret** through a `SecretStore` before the handler starts, and deletes it once Tron
  records the report. `FileSecretStore` keeps one `0600` file per delivery in a directory you choose; implement
  `SecretStore` to use a database or secret manager instead.
- **Reports** the handler's `ok(message)` or `err(message)` (a handler that throws is reported as `err`). A rejected
  report is a `ReportRejectedError` and is not retried; the secret is kept. After a restart,
  `runner.pendingDeliveries()` lists the deliveries whose secret the store still holds and
  `runner.reportPending(deliveryId, outcome)` reports one.
- **Drains** on `stop()`: no new work is taken, running handlers finish, Tron answers their reports, then the
  connection closes.

A runner can register any number of handlers. Each `work` frame names the handler key it was dispatched for, and the
SDK runs the handler registered under that key. A delivery for a key with no registered handler is not accepted and
surfaces an `UnknownHandlerError` (with `deliveryId` and `handlerKey`) through the `error` event. Multi-handler routing needs a Tron whose `work` frame carries `handler_key`.

The wire messages are generated from Tron's published AsyncAPI document, so the package cannot drift from the protocol
by hand-editing; see the [repository](https://github.com/umbra-yurei/tron-runner-sdk) for the thin-SDK contract and the
conformance suite this package passes against a real Tron.
