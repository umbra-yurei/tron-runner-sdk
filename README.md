# tron-runner-sdk

Public runner SDKs for [Tron](https://github.com/umbra-yurei/tron), one package per language, all generated from
one published protocol schema and held to one conformance suite.

| Path | What it is |
| --- | --- |
| `protocol/` | Vendored copies of Tron's served runner protocol (`asyncapi.json`) and REST contract (`tron.openapi.json`) |
| `contract/` | The language-neutral [thin-SDK contract](contract/sdk-contract.md) and the authored adapter protocol schema |
| `tools/` | Reproducible generation (`generate.ts`) and drift checks (`sync-protocol.ts`) |
| `packages/<language>/` | Each SDK; its `generated/` message bindings and recorded protocol version are emitted, never hand-written |
| `conformance/` | The shared [conformance suite](conformance/README.md) and a reference adapter |

Needs Node >= 22.18 (it runs the TypeScript tooling directly).

```sh
npm ci
npm run generate          # rewrite every package's bindings from protocol/asyncapi.json
npm run check             # CI: fail on stale generated output, then type-check tooling and harness
npm run sync:protocol     # refresh protocol/ from a Tron checkout (TRON_DIR=../tron) or a running one (TRON_URL=...)
npm run check:protocol    # fail if protocol/ has drifted from Tron
npm run conformance       # run every adapter against a real Tron; see conformance/README.md
```

`check:protocol` and `conformance` need Tron (a checkout or a running dev-mode instance), so CI runs only `check`.

## Updating the protocol

1. `npm run sync:protocol` pulls Tron's current documents into `protocol/`.
2. `npm run generate` re-emits every package's bindings, including its `PROTOCOL_VERSION`.
3. Commit all of it. A package whose generated output is stale fails `npm run check`.

Generation uses [quicktype](https://quicktype.io) (version pinned in `package.json`) for all five languages, so a
change to Tron's frame types reaches every SDK the same way.
