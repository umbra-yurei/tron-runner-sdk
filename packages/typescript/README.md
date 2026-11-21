# @cruma-io/tron-runner

Runner SDK for [Tron](https://github.com/umbra-yurei/tron), the scheduling service. A runner connects with a worker
API key, announces the handlers it can run, and Tron pushes work for jobs whose handler key it announced. The SDK
accepts each delivery immediately, persists the one-time delivery secret, runs your handler and reports `Ok` or `Err`.

Needs Node 22 or newer (it uses the built-in `WebSocket`). No runtime dependencies.

```sh
npm install @cruma-io/tron-runner
```

```ts
import { err, FileSecretStore, ok, Runner } from "@cruma-io/tron-runner";

const runner = new Runner({
  url: "https://tron.example.com",
  token: process.env.TRON_WORKER_KEY!,
  secretStore: new FileSecretStore("./.tron-secrets"),
  concurrencyCapacity: 4,
});

runner.handle("nightly-backup", async (delivery) => {
  try {
    await backup(delivery.jobName);
    return ok("backup finished");
  } catch (error) {
    return err(String(error));
  }
});

runner.on("error", (error) => console.error(error.kind, error.message));

await runner.start(); // rejects with a typed error if Tron is unreachable or refuses the key
process.on("SIGTERM", () => void runner.stop()); // drains in-flight work first
```

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

A runner that registers more than one handler cannot receive deliveries yet: protocol `v1`'s `work` frame does not name
the handler key it was dispatched for, so the SDK emits an `UnroutableDeliveryError` and does not accept the delivery
rather than guess. Register one handler per runner process until Tron adds the key to `work`.

The wire messages are generated from Tron's published AsyncAPI document, so the package cannot drift from the protocol
by hand-editing; see the [repository](https://github.com/umbra-yurei/tron-runner-sdk) for the thin-SDK contract and the
conformance suite this package passes against a real Tron.
