# Conformance suite

One runner (`run.ts`) drives every registered SDK adapter through the same cases against a **real Tron**: the
documented local stack (`make db-up` + `make dev` with `AUTH_MODE=dev`) or an already running dev-mode Tron.
It creates users, worker keys and jobs through Tron's REST API with a client generated from Tron's own OpenAPI
contract (`generated/tron-api.d.ts`), so there is no second server fixture and no hand-written wire shape.

## Running

```sh
npm ci
npm run conformance                                    # starts Tron from ../tron (TRON_DIR), tears it down after
TRON_URL=http://127.0.0.1:8090 npm run conformance     # attach to a running AUTH_MODE=dev Tron instead
npm run conformance -- --adapter reference-typescript --scenario drains
npm run conformance -- --list
```

Environment: `TRON_URL` (attach), else `TRON_DIR` (default `../tron`), `TRON_PORT` (default 8090) and `DATABASE_URL`
(default Tron's local Postgres). Starting Tron needs a container engine for its Postgres and Tron's Rust toolchain;
the first start compiles Tron. Tron's server log goes to `conformance/.run/tron.log`.

## Cases

authentication and announce; typed failure for a bad token and an unreachable Tron; reconnect after a dropped
connection; handler-filtered delivery; accept + `Ok`; accept + `Err`; restart between accept and report;
`wrong_secret`, `not_in_flight` and `delivery_timed_out` rejections; graceful drain (in-flight work finishes and its report acknowledgement arrives, with the proxy holding the acknowledgement, before `stopped`). Capacity cases are added after
Tron's capacity-aware dispatch (board task `e58057dd`) lands.

Not covered black-box: `unknown_delivery` (either direction) and `already_resolved`, which an SDK cannot provoke
against Tron without forging frames; Tron's own `backend/tests/runner_protocol.rs` covers them.

## Writing an adapter

An adapter is a process. The harness writes one JSON command per line to its stdin and reads one JSON event per line
from its stdout (diagnostics go to stderr). The messages are defined once, in
[`../contract/adapter-protocol.schema.json`](../contract/adapter-protocol.schema.json), and generated into every
package by `npm run generate` — an adapter decodes and encodes them with its own generated bindings.

Contract for each message is in the schema's descriptions. In short:

1. On launch, write `ready` (SDK version, supported protocol version).
2. On `start`, build the SDK with the given URL, token, handlers (each a scripted `Ok`/`Err` reply after
   `delay_ms`), capacity and secret store (`file` is the SDK default; `tampered` and `retaining` wrap it), connect,
   and write `connected` (and again after every reconnect) or `connect_failed`.
3. Write `handler_invoked`, `delivery_accepted`, `report_recorded`, `accept_refused` and `report_rejected` as the SDK
   goes. An `error` event means the SDK failed outside the typed paths and fails the scenario.
4. `list_pending` -> `pending`; `report_pending` reports an earlier accepted delivery from the secret store.
5. `stop` drains — every accepted delivery's report is acknowledged or rejected by Tron before `stopped` — then exits 0.

Incoming frames and commands are decoded with a generated tag probe (`Convert.toServerFrameTag`, `toAdapterCommandTag`)
that reads only `type`, then dispatched to the generated decoder for that kind; there are no hand-written shapes.

The Python adapter (`adapters/python/adapter.py`) uses the SDK's public API, so it needs the package's
virtualenv first: `python3 -m venv packages/python/.venv && packages/python/.venv/bin/pip install -e 'packages/python[dev]'`.

Register it in [`adapters.json`](adapters.json) (`name`, `command`, `cwd` relative to the repository root). The
reference adapter in `adapters/reference/` implements all of this on Node's WebSocket and is what keeps the harness
itself tested.
