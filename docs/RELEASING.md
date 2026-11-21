# Releasing the SDKs

All five SDKs release from one commit on `main` that carries one version. Publishing is operator work: the crates.io,
PyPI and npm credentials live with the operator and never enter this repository, CI or a log; NuGet publishes from
GitHub Actions through trusted publishing and has no stored key.

## Before tagging

1. `main` is green: `npm ci && npm run check`, each package's own build and tests, and `npm run conformance` against a
   running Tron (see [`conformance/README.md`](../conformance/README.md)). Do not publish a package whose generated-schema
   or conformance check is red.
2. `npm run check:protocol` shows `protocol/` has not drifted from the Tron you are releasing against.
3. The version is the same in every manifest, and `RELEASES.md` lists it with the protocol version it supports:
   - `packages/rust/Cargo.toml` (`version`)
   - `packages/typescript/package.json` (`version`)
   - `packages/python/src/tron_runner/_version.py` (`__version__`)
   - `packages/dotnet/src/Cruma.Tron.Runner.csproj` (`<Version>`)
   - `packages/go/version.go` (`SDKVersion`)
4. Each registry accepts the artifact (nothing is uploaded):
   - `cd packages/rust && cargo publish --dry-run --locked`
   - `cd packages/typescript && npm pack --dry-run`
   - `cd packages/python && python -m build` (needs `pip install -e '.[dev]'`)
   - `dotnet pack packages/dotnet/src -c Release -o packages/dotnet/pack`

## Publishing

Run these from a clean checkout of the release commit, in this order, and stop at the first failure. A published
version cannot be replaced; a bad release is fixed by the next patch version.

| Registry | Command | Credential |
| --- | --- | --- |
| crates.io | `cd packages/rust && cargo publish --locked` | `CARGO_REGISTRY_TOKEN` from the operator's token file |
| PyPI | `cd packages/python && python -m build && twine upload dist/*` | `TWINE_USERNAME=__token__`, `TWINE_PASSWORD` from the operator's token file |
| npm | `cd packages/typescript && npm publish` (`publishConfig.access` is already `public`) | operator's npm login for the `cruma-io` org |
| Go | `git tag packages/go/vX.Y.Z <release-sha> && git push origin packages/go/vX.Y.Z` | push access |
| NuGet | `git tag vX.Y.Z <release-sha> && git push origin vX.Y.Z`; `.github/workflows/release-nuget.yml` does the rest | none stored |

Notes:

- The Go module path is `github.com/umbra-yurei/tron-runner-sdk/packages/go`, so its tag carries the `packages/go/`
  prefix. Check it resolves: `go list -m github.com/umbra-yurei/tron-runner-sdk/packages/go@vX.Y.Z`.
- The NuGet workflow refuses a tag that does not equal `v` plus the csproj `<Version>`. It needs the repository
  variable `NUGET_USER` (the nuget.org profile name that owns the trusted-publishing policy) and the `nuget-release`
  environment, which only accepts `v*` tags. Every action in it is pinned to a full commit SHA because the
  organisation requires that; update the SHA and the version comment together.
- Tag the commit once, as `vX.Y.Z`, so the tag also marks the release for the other four SDKs.

## After publishing

1. Set the "Published" cell of each row in `RELEASES.md` to the date, and commit.
2. Install each published package from its registry into an empty project and import it (not from the repository).

## Proving two SDKs against production

Pick two released SDKs, install each from its registry, and for each:

1. Create a worker API key in the production Tron web UI and a job that targets the runner with the SDK's handler key.
2. Start a minimal runner with the SDK (`Runner` with one handler returning `Ok`), pointed at production Tron.
3. Trigger the job from the UI. Record the delivery, the accept, and the reported `Ok` from the run's page, with the
   SDK name and version, on the release task's thread. Never paste a worker key or a delivery secret.
