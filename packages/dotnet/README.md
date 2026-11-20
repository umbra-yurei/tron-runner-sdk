# Cruma.Tron.Runner

The .NET runner SDK for [Tron](https://github.com/umbra-yurei/tron). It connects your process to Tron over a
WebSocket with a worker API key, receives the jobs Tron pushes to your handlers, accepts them, and reports the
result as `Outcome.Ok(...)` or `Outcome.Err(...)`.

Protocol messages are generated from Tron's published AsyncAPI document; the SDK holds no hand-written wire model.

```csharp
using Cruma.Tron.Runner;

await using var runner = new RunnerClient(new RunnerClientOptions
{
    TronUrl = new Uri("https://tron.example.com"),
    Token = Environment.GetEnvironmentVariable("TRON_WORKER_KEY")!,
    SecretDirectory = "/var/lib/my-runner/secrets",
});

runner.Handle("backup", async (delivery, cancellationToken) =>
{
    await RunBackupAsync(delivery.JobName, cancellationToken);
    return Outcome.Ok("backup finished");
});

await runner.ConnectAsync();   // throws ConnectFailedException when Tron cannot be reached or rejects the key
// ... run until shutdown ...
await runner.StopAsync();      // takes no new work, waits for in-flight handlers and Tron's answers to their reports
```

- Reconnects after a lost connection with a capped backoff and announces again.
- Accepts each delivery immediately, then runs your handler; a handler that throws is reported as `Err`.
- Keeps each delivery's secret in an `ISecretStore` (a file per delivery, mode 0600, by default) until Tron records
  the report, so a restarted process can still report with `ReportPendingAsync`.
- Typed refusals: `AcceptRefusedException`, `ReportRejectedException`, `ConnectFailedException`,
  `ProtocolViolationException`.

Known limit of protocol v1: `work` frames do not name the handler they were dispatched for, so a runner that
registers more than one handler cannot route work and raises `HandlerRoutingException` through `Faulted` instead
of accepting it. Register one handler per runner until Tron's protocol names the handler.
