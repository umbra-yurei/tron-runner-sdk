# Cruma.Tron.Runner

The .NET runner SDK for [Tron](https://github.com/umbra-yurei/tron). It connects your process to Tron over a
WebSocket with a worker API key, receives the jobs Tron pushes to your handlers, accepts them, and reports the
result as `Outcome.Ok(...)` or `Outcome.Err(...)`.

Protocol messages are generated from Tron's published AsyncAPI document; the SDK holds no hand-written wire model.

<!-- tron-runner-example:start -->
```csharp
using Cruma.Tron.Runner;

await using var runner = new RunnerClient(new RunnerClientOptions
{
    TronUrl = new Uri(Environment.GetEnvironmentVariable("TRON_URL")!),
    Token = Environment.GetEnvironmentVariable("TRON_WORKER_KEY")!,
    SecretDirectory = Environment.GetEnvironmentVariable("TRON_SECRET_DIR")!,
});

runner.Handle("send-report", (delivery, cancellationToken) =>
{
    // Ok marks the run succeeded and Err marks it failed; both carry a message.
    return Task.FromResult(Outcome.Ok($"sent the report for {delivery.JobName}"));
});

await runner.ConnectAsync();

// ... keep the process alive; when it is told to shut down:
await runner.StopAsync(); // finish in-flight work, report it, then close
```
<!-- tron-runner-example:end -->

- Reconnects after a lost connection with a capped backoff and announces again.
- Accepts each delivery immediately, then runs your handler; a handler that throws is reported as `Err`.
- Keeps each delivery's secret in an `ISecretStore` (a file per delivery, mode 0600, by default) until Tron records
  the report, so a restarted process can still report with `ReportPendingAsync`. A secret directory that does not
  exist is created 0700; an existing one that group or others can access is refused with
  `InsecureSecretDirectoryException` (the SDK never changes permissions on a directory it did not create).
- Typed refusals: `AcceptRefusedException`, `ReportRejectedException`, `ConnectFailedException`,
  `ProtocolViolationException`.

Known limit of protocol v1: `work` frames do not name the handler they were dispatched for, so a runner that
registers more than one handler cannot route work and raises `HandlerRoutingException` through `Faulted` instead
of accepting it. Register one handler per runner until Tron's protocol names the handler.
