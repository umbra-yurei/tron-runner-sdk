# Thin-SDK contract

What every Tron runner SDK (Rust, Python, TypeScript, .NET, Go) does, in language-neutral terms.
The wire protocol itself is Tron's published AsyncAPI document ([`protocol/asyncapi.json`](../protocol/asyncapi.json),
served at `GET /api/asyncapi.json`); this file never restates a frame or field. An SDK's protocol messages are
the **generated** bindings in its package (`npm run generate`); an SDK must not hand-write a JSON shape.

Conformance is tested by one shared suite ([`conformance/`](../conformance/README.md)) that drives each SDK through
the adapter protocol ([`adapter-protocol.schema.json`](adapter-protocol.schema.json)). A statement below that the suite
checks is marked **[tested]**.

## Surface

1. **Connect and authenticate** with a worker API key and the Tron base URL. The runner channel's path comes from
   the generated `RUNNER_CHANNEL_ADDRESS` constant, never a literal. **[tested]**
   - Failure to authenticate is a typed error (`authentication_failed`), not retried. **[tested]**
   - The first connection attempt failing at the transport is a typed `unreachable` error, returned to the caller.
     **[tested]**
   - Once connected, a lost connection is re-established automatically with exponential backoff (start small, double,
     cap at a few seconds) and a fresh authenticate + announce; the caller sees a new session, not an exception.
     **[tested]**
2. **Announce** handler keys, concurrency capacity, optional display name and runner version, the SDK's semantic
   version and the protocol version (the generated `PROTOCOL_VERSION`). A rejected announcement is a typed
   `announcement_rejected` error. **[tested]**
3. **Register handlers**: a handler is a function from a delivery (run id, job id, job name, delivery id, deadline)
   to an `Ok(message)` or `Err(message)` outcome. The set of registered handler keys is what is announced; Tron
   only pushes work for a job whose handler key a session announced. **[tested]**
   - A `work` frame's `handler_key` selects the handler the delivery runs, so one runner can register several handlers.
     A key with no registered handler is not accepted and is a typed `unknown_handler` error naming the delivery and
     key; the SDK never falls back to another handler. **[tested]**
4. **Accept immediately.** On `work` the SDK sends `accept` before running the handler. Acceptance past the deadline
   is refused by Tron; that is a typed `accept_refused` error carrying the closed refusal reason and the handler is
   not run. **[tested: delivery_timed_out]**
5. **Persist the delivery secret** Tron returns on acceptance *before* running the handler, through a pluggable
   secret store (see below). **[tested]**
6. **Report once** with the persisted secret when the handler finishes: `Ok` or `Err` with a string message. The
   report may be sent on a different connection than the one that accepted, including after a process restart
   (`report_pending`). **[tested]**
   - A recorded report deletes the stored secret. **[tested]**
   - A rejected report is a typed `report_rejected` error with the closed rejection reason; the SDK does not retry
     it and does not delete the secret. **[tested: wrong_secret, not_in_flight]**
7. **Typed errors.** Every Tron refusal (`AcceptRefusal`, `ReportRejection`, `ProtocolViolation`) and every connect
   failure surfaces as a value of the generated closed enum, never as free text parsed from a message.
8. **Graceful drain and shutdown.** `stop` stops taking new work, waits for in-flight handlers to finish and for
   their reports to be answered, then closes the connection and returns. **[tested]**

Retries of failed deliveries are Tron's concern and not part of this contract.

## Secret store

```
save(delivery_id, secret)
load(delivery_id) -> secret | none
remove(delivery_id)
pending() -> [delivery_id]       // accepted, not yet reported
```

The SDK ships a **local-file default** (one `0600` file per delivery in a caller-chosen directory) and lets a caller
supply their own implementation (a database, a secret manager). It is the only state that survives a restart.
The conformance suite runs the default plus two wrappers the adapter builds through the same interface:
`tampered` (returns a wrong secret from `load`) and `retaining` (never removes). **[tested]**

## Adapter

An adapter is the smallest program that exposes an SDK to the suite. See
[`conformance/README.md`](../conformance/README.md) for the process protocol and how to register one.
