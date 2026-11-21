# Release notes

Every SDK release declares the runner protocol it speaks: `protocol_version` is what the SDK announces to Tron, and
the document version is the `version` of the AsyncAPI document (`protocol/asyncapi.json`) its bindings were generated
from. Both are emitted into each package by `npm run generate`, so the table below can be checked against
`packages/*/.../generated/protocol_version.*`. How to cut a release is in [`docs/RELEASING.md`](docs/RELEASING.md).

| SDK | Registry name | Version | Runner protocol | AsyncAPI document | Git tag | Published |
| --- | --- | --- | --- | --- | --- | --- |
| Rust | `cruma-tron-runner` (crates.io) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| Python | `cruma-tron-runner` (PyPI) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| TypeScript | `@cruma-io/tron-runner` (npm) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| .NET | `Cruma.Tron.Runner` (NuGet) | 0.1.0 | v1 | 0.1.0 | `v0.1.0` | not yet |
| Go | `github.com/umbra-yurei/tron-runner-sdk/packages/go` | 0.1.0 | v1 | 0.1.0 | `packages/go/v0.1.0` | not yet |

The "Published" column changes from "not yet" to the publish date in the commit that follows each publish.

## 0.1.0

First release of all five SDKs. Each connects with a worker API key, announces its handler keys, accepts each delivery
immediately, persists the delivery's one-time secret before running the handler, reports exactly one `Ok` or `Err`,
reconnects after a dropped connection and drains in-flight work on stop. Conformance against a real Tron is described in
[`conformance/README.md`](conformance/README.md).

Known limit: the work frame names the handler key it was dispatched for (`handler_key`, protocol v1), but the SDKs do not
yet route a delivery to the matching handler, so a runner should register one handler per connection until that lands
(board task `3e3b9da6`).
