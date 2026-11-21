# Release notes

Every SDK release declares the runner protocol it speaks: `protocol_version` is what the SDK announces to Tron, and
the document version is the `version` of the AsyncAPI document (`protocol/asyncapi.json`) its bindings were generated
from. Both are emitted into each package by `npm run generate`, so the table below can be checked against
`packages/*/.../generated/protocol_version.*`. How to cut a release is in [`docs/RELEASING.md`](docs/RELEASING.md).

| SDK | Registry name | Version | Runner protocol | AsyncAPI document | Git tag | Published |
| --- | --- | --- | --- | --- | --- | --- |
| Rust | `cruma-tron-runner` (crates.io) | 0.1.1 | v1 | 0.1.0 | `packages/rust/v0.1.1` | not yet |
| Python | `cruma-tron-runner` (PyPI) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| TypeScript | `@cruma-io/tron-runner` (npm) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| .NET | `Cruma.Tron.Runner` (NuGet) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| Go | `github.com/umbra-yurei/tron-runner-sdk/packages/go` | 0.1.0 | v1 | 0.1.0 | `packages/go/v0.1.0` | not yet |

The "Published" column changes from "not yet" to the publish date in the commit that follows each publish.

## Rust 0.1.1

Rust only; the other four SDKs stay at 0.1.0 and the protocol is unchanged (v1, AsyncAPI document 0.1.0). Fixes a panic on the first
`wss://` connection: 0.1.0 enabled rustls without selecting a crypto provider, so every connection to an `https://` Tron
ended in "Could not automatically determine the process-level CryptoProvider". The SDK now builds an explicit rustls
configuration with the `ring` provider and the bundled root certificates, and a test performs a real TLS handshake. 0.1.0
is to be yanked once 0.1.1 is live (`cargo yank --version 0.1.0 cruma-tron-runner`).

## 0.1.0

First release of all five SDKs. Each connects with a worker API key, announces its handler keys, accepts each delivery
immediately, persists the delivery's one-time secret before running the handler, reports exactly one `Ok` or `Err`,
reconnects after a dropped connection and drains in-flight work on stop. Conformance against a real Tron is described in
[`conformance/README.md`](conformance/README.md).

Each delivery is routed by the work frame's `handler_key` (protocol v1) to the handler registered under that key, so one
runner can register several handlers on one connection. A key with no registered handler is refused with a typed
`unknown_handler` error. Every adapter passes the two-handler routing case of the conformance suite.

`concurrency_capacity` is optional in the protocol (Tron defaults an omitted value to 1), but every SDK still announces
it, so a 0.1.0 runner is accepted by Tron versions that require the field as well as by current ones.
