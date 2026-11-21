# Tron runner SDK for Go

`github.com/umbra-yurei/tron-runner-sdk/packages/go` connects a Go program to Tron's runner channel: it
authenticates with a worker API key, announces the handlers it can run, accepts each delivery immediately,
persists the delivery's one-time secret, runs your handler and reports exactly one `Ok` or `Err`.

```go
runner, err := tronrunner.New(tronrunner.Config{
	BaseURL: "https://tron.example.com",
	Token:   os.Getenv("TRON_WORKER_KEY"),
	Hooks:   tronrunner.Hooks{OnError: func(err error) { log.Print(err) }},
})
if err != nil { log.Fatal(err) }

runner.Handle("backup", func(ctx context.Context, d tronrunner.Delivery) tronrunner.Outcome {
	if err := backup(ctx, d.JobName); err != nil {
		return tronrunner.Err(err.Error())
	}
	return tronrunner.Ok("backed up")
})

if err := runner.Connect(ctx); err != nil { // *tronrunner.ConnectError
	log.Fatal(err)
}
<-ctx.Done()
_ = runner.Stop(context.Background()) // stop taking work, finish and report what is in flight, close
```

What it does is specified once, language-neutrally, in [`contract/sdk-contract.md`](../../contract/sdk-contract.md) and
checked by the shared [conformance suite](../../conformance/README.md); this package is held to the same cases as the
other SDKs.

| Contract item | Go |
| --- | --- |
| Connect, authenticate | `Runner.Connect`; the first failure is a `*ConnectError` with a generated `ConnectFailure` reason (`authentication_failed`, `announcement_rejected`, `unreachable`) |
| Reconnect | automatic after the first success: exponential backoff (`Config.Reconnect`, default 100ms doubling to 5s), fresh authenticate + announce, `Hooks.OnConnected` per session. A refused reconnect (revoked key) ends the runner; see `Runner.Wait` |
| Announce, handlers | `Runner.Handle(key, handler)` before `Connect`; the registered keys are announced with the capacity, SDK version and the generated protocol version |
| Accept | sent from the read loop the moment `work` arrives; a refusal is a `*AcceptRefusedError` (generated `AcceptRefusal`) and the handler is not run |
| Secret persistence | `SecretStore` interface; default `FileSecretStore` (one `0600` file per delivery in a directory you choose, or `DefaultSecretDirectory()`). The secret is saved before the handler runs and the report uses the stored copy |
| Report | `Outcome` is `Ok(msg)` or `Err(msg)`; a rejection is a `*ReportRejectedError` (generated `ReportRejection`), not retried, secret kept. `Runner.ReportPending` reports an earlier accepted delivery from the store, e.g. after a restart |
| Drain | `Runner.Stop(ctx)` |

Errors reach you through `Hooks.OnError` (work the runner does on its own) or a return value, always as the typed
errors in `errors.go`; match them with `errors.As`.

A runner with more than one handler cannot route a delivery in protocol `v1`, because a `work` frame does not name
the handler key it was dispatched for (see the contract's *Known protocol gap*). Such a delivery is not accepted and
surfaces as `*UnroutableDeliveryError` through `OnError`.

## Layout

| Path | |
| --- | --- |
| `generated/` | Protocol messages and version constants, **generated** from `protocol/asyncapi.json` by `npm run generate`; never edited by hand |
| `*.go` | The SDK (`package tronrunner`) |
| `conformance/adapter/` | The adapter the conformance suite drives (`conformance/adapters.json`) |

## Develop

```sh
cd packages/go
go vet ./... && go test -race ./...
cd ../.. && npm run conformance -- --adapter go   # against a real local Tron; see conformance/README.md
```

## Release

The module lives in a subdirectory, so Go module tags are prefixed with its path: `git tag packages/go/v0.1.0`
makes `go get github.com/umbra-yurei/tron-runner-sdk/packages/go@v0.1.0` resolve. Set `SDKVersion` in `version.go` to
the same version first (it is what the SDK announces to Tron). The supported protocol version and the bindings are
verified in CI (`npm run check` fails if `generated/` is stale; `npm run check:bindings` builds it with Go).
Tagging itself is board task `36ca7e8e`.
