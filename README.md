# tron-runner-sdk

Public runner SDKs for [Tron](https://github.com/umbra-yurei/tron), one package per language, all generated from
one published protocol schema and held to one conformance suite.

| Path | What it is |
| --- | --- |
| `protocol/` | Vendored copies of Tron's served runner protocol (`asyncapi.json`) and REST contract (`tron.openapi.json`) |
| `contract/` | The language-neutral [thin-SDK contract](contract/sdk-contract.md) and the authored adapter protocol schema |
| `tools/` | Reproducible generation (`generate.ts`) and drift checks (`sync-protocol.ts`) |
| `packages/<language>/` | Each SDK; its `generated/` message bindings and recorded protocol version are emitted, never hand-written |
| `packages/dotnet/` | The `Cruma.Tron.Runner` NuGet package, its tests and its conformance adapter (`npm run build:dotnet-adapter`, `npm run test:dotnet`) |
| `conformance/` | The shared [conformance suite](conformance/README.md) and a reference adapter |

Needs Node >= 22.18 (it runs the TypeScript tooling directly).

```sh
npm ci
npm run generate          # rewrite every package's bindings from protocol/asyncapi.json
npm run check             # CI: fail on stale generated output, then type-check tooling and harness
npm run sync:protocol     # refresh protocol/ from a Tron checkout (TRON_DIR=../tron) or a running one (TRON_URL=...)
npm run check:bindings    # build each language's generated bindings with its own toolchain and round-trip sample messages
npm run check:protocol    # fail if protocol/ has drifted from Tron
npm run conformance       # run every adapter against a real Tron; see conformance/README.md
```

The Python SDK's checks are `mypy` and `pytest` in `packages/python` (CI job `python-sdk`); see
[`packages/python/README.md`](packages/python/README.md). Its conformance adapter runs from a virtualenv at
`packages/python/.venv`: `python3 -m venv packages/python/.venv && packages/python/.venv/bin/pip install -e 'packages/python[dev]'`.

`check:protocol` and `conformance` need Tron (a checkout or a running dev-mode instance), so CI runs only `check` and `check:bindings --require-all` (which needs Rust, Python, Go and .NET toolchains; locally a language whose toolchain is missing is skipped).

## Updating the protocol

1. `npm run sync:protocol` pulls Tron's current documents into `protocol/`.
2. `npm run generate` re-emits every package's bindings, including its `PROTOCOL_VERSION`.
3. Commit all of it. A package whose generated output is stale fails `npm run check`.

Generation uses [quicktype](https://quicktype.io) (version pinned in `package.json`) for all five languages, so a
change to Tron's frame types reaches every SDK the same way.
