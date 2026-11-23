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
npm run conformance -- --concurrency 1                # cases run 8 at a time by default; 1 runs them strictly in order
```

Adapters that need a build step are built first: `npm run build:dotnet-adapter` for `dotnet` (.NET 8 SDK).

Environment: `TRON_URL` (attach), else `TRON_DIR` (default `../tron`), `TRON_PORT` (default 8090) and `DATABASE_URL`
(default Tron's local Postgres). Starting Tron needs a container engine for its Postgres and Tron's Rust toolchain;
the first start compiles Tron. Tron's server log goes to `conformance/.run/tron.log`.

## Release gate

`npm run conformance:release` is the run that decides whether a release may be tagged ([`docs/RELEASING.md`](../docs/RELEASING.md)).
It differs from `npm run conformance` in three ways that each close a hole a source-tree, plain-`ws://` run leaves open:

- **Packed artifacts.** It exports the release commit with `git archive`, packs each SDK as it is published (`cargo package`,
  `npm pack`, a wheel, `dotnet pack`, a Go module zip served from a `file://` module proxy) and builds each SDK's adapter
  against that artifact: the Rust adapter depends on the unpacked `.crate`, the TypeScript adapter's SDK import is redirected
  to the package installed from the `.tgz` (`artifact-redirect.ts`), Python runs in a venv with only the wheel, .NET restores the
  `.nupkg` from a local feed, and Go requires the module by version from the zip. Each stager then checks the SDK really
  resolved from the artifact, and the run prints every artifact's sha256.
- **TLS.** Tron listens on plain HTTP inside its container, as in deployment, behind a TLS terminator (`tls.ts`) with a
  certificate from a throwaway CA (`mkcerts.go`) that is created for the run and deleted with it. Every SDK is told to trust that
  CA through its normal hook: `SSL_CERT_FILE` for Python, Go, .NET and the Rust adapter (which passes it to the SDK's public
  `RunnerBuilder::trust_root`), `NODE_EXTRA_CA_CERTS` for Node. The harness's own WebSocket proxies (reconnect, held frames) serve the
  same certificate, so those cases cross TLS too.
- **A pinned Tron, built and run in containers.** `pin.ts` names the commits of Tron and the two repositories its Cargo path
  dependencies live in (`umbra-auth`, `cruma-web-api`), and the Postgres image. They are exported with `git archive` and built by
  `Containerfile.tron` (backend only), then started with `AUTH_MODE=dev` next to Postgres on a private podman network. The pin is
  the Tron running in production; move it when production moves, in a commit that says so. The host needs `git`, `podman`, Node 22,
  and the toolchains of the SDKs (`cargo`, `python3` with `venv`, `npm`, `dotnet`, `go`); the sibling checkouts default to `../tron`,
  `../umbra-auth`, `../cruma-web-api` (`TRON_DIR`, `UMBRA_AUTH_DIR`, `CRUMA_WEB_API_DIR`). The first run builds Tron's image (a few
  minutes); later runs reuse it.

`--ref <commit|tag>` proves another commit (without it the committed `HEAD` is used and a dirty tree is refused, because the run
proves what will be tagged); `--only rust,go` and `--scenario <substring>` narrow the run for iteration only; `--keep` keeps the
work directory, which is kept on failure anyway, in `conformance/.run/release/<run>/` with one log per step.

## Cases

authentication and announce; typed failure for a bad token and an unreachable Tron; reconnect after a dropped
connection; handler-filtered delivery; two handlers on one runner each receiving the delivery for their own `handler_key`; accept + `Ok`; accept + `Err`; restart between accept and report;
`wrong_secret`, `not_in_flight` and `delivery_timed_out` rejections; graceful drain (in-flight work finishes and its report acknowledgement arrives, with the proxy holding the acknowledgement, before `stopped`). The suite has no capacity cases: it does not test how many deliveries
Tron sends a runner at once, or any other part of Tron's capacity-aware dispatch.

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

Register it in [`adapters.json`](adapters.json) (`name`, `command`, `cwd` relative to the repository root, and an optional `build` command the runner executes once from `cwd` before launching: a compiled SDK builds its adapter there, because a `go run`/`cargo run` wrapper would leave an orphan child when the harness kills the adapter). The
reference adapter in `adapters/reference/` implements all of this on Node's WebSocket and is what keeps the harness
itself tested.

## Registered adapters

- `reference-typescript` — the reference adapter in `adapters/reference/`.
- `python` — `conformance/adapters/python/adapter.py`, over the public API of `cruma-tron-runner`; it needs the virtualenv at
  `packages/python/.venv` described above.
- `rust` — `packages/rust/conformance-adapter`, a binary over the public API of the `cruma-tron-runner` crate. The harness
  starts it with `cargo run`, and an adapter must write `ready` within seconds, so build it once first:
  `cargo build --manifest-path packages/rust/Cargo.toml -p cruma-tron-runner-conformance-adapter`.
- `go` — `packages/go/conformance/adapter`, a binary over the public API of the Go module. Its `build` step compiles it to `packages/go/.bin/conformance-adapter` before each run (needs Go 1.23+).
