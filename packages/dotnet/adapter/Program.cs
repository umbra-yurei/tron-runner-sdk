// The conformance adapter for the .NET SDK: the smallest program that exposes Cruma.Tron.Runner to the shared
// conformance suite (conformance/README.md). Commands and events are the generated adapter-protocol bindings,
// decoded with a tag probe first; nothing here defines a JSON shape.
using Cruma.Tron.Runner;
using Cruma.Tron.Runner.Generated;

var output = new object();

void Emit(string line)
{
    lock (output)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }
}

void Fail(string message) => Emit(new AdapterErrorEvent { Type = AdapterErrorEventType.Error, Message = message }.ToJson());

Emit(new ReadyEvent
{
    Type = ReadyEventType.Ready,
    SdkVersion = RunnerClient.SdkVersion,
    ProtocolVersion = RunnerClient.SupportedProtocolVersion,
}.ToJson());

RunnerClient? client = null;
var background = new List<Task>();

string? line;
while ((line = await Console.In.ReadLineAsync()) is not null)
{
    if (string.IsNullOrWhiteSpace(line))
    {
        continue;
    }

    try
    {
        switch (AdapterCommandTag.FromJson(line).Type)
        {
            case AdapterCommandKindEnum.Start:
                client = await StartAsync(StartCommand.FromJson(line));
                break;
            case AdapterCommandKindEnum.ReportPending:
                var report = ReportPendingCommand.FromJson(line);
                var pending = Required(client);
                background.Add(Task.Run(() => ReportPendingAsync(pending, report)));
                break;
            case AdapterCommandKindEnum.ListPending:
                var ids = await Required(client).PendingDeliveriesAsync();
                Emit(new PendingEvent { Type = PendingEventType.Pending, DeliveryIds = ids.ToList() }.ToJson());
                break;
            case AdapterCommandKindEnum.Stop:
                await Required(client).StopAsync();
                await Task.WhenAll(background);
                Emit(new StoppedEvent { Type = StoppedEventType.Stopped }.ToJson());
                return 0;
        }
    }
    catch (Exception ex)
    {
        Fail(ex.Message);
    }
}

if (client is not null)
{
    await client.DisposeAsync();
}

return 0;

static RunnerClient Required(RunnerClient? client) =>
    client ?? throw new InvalidOperationException("no start command was received");

async Task<RunnerClient> StartAsync(StartCommand command)
{
    var store = StoreFor(command.SecretStore);
    var runner = new RunnerClient(new RunnerClientOptions
    {
        // The harness hands over the full runner URL; the SDK appends the channel address itself.
        TronUrl = new Uri(new Uri(command.TronUrl).GetLeftPart(UriPartial.Authority)),
        Token = command.Token,
        ConcurrencyCapacity = (int)command.ConcurrencyCapacity,
        DisplayName = command.DisplayName,
        RunnerVersion = command.RunnerVersion,
        SecretStore = store,
    });
    foreach (var script in command.Handlers)
    {
        runner.Handle(script.HandlerKey, async (delivery, cancellation) =>
        {
            Emit(new HandlerInvokedEvent
            {
                Type = HandlerInvokedEventType.HandlerInvoked,
                HandlerKey = script.HandlerKey,
                DeliveryId = delivery.DeliveryId,
                RunId = delivery.RunId,
                JobId = delivery.JobId,
                JobName = delivery.JobName,
            }.ToJson());
            await Task.Delay(TimeSpan.FromMilliseconds(script.DelayMs), cancellation);
            return script.Outcome == HandlerOutcomeKindEnum.ReplyOk ? Outcome.Ok(script.Message) : Outcome.Err(script.Message);
        });
    }

    runner.SessionStarted += sessionId =>
        Emit(new ConnectedEvent { Type = ConnectedEventType.Connected, SessionId = sessionId }.ToJson());
    runner.DeliveryAccepted += deliveryId =>
        Emit(new DeliveryAcceptedEvent { Type = DeliveryAcceptedEventType.DeliveryAccepted, DeliveryId = deliveryId }.ToJson());
    runner.AcceptRefused += refusal =>
        Emit(new AcceptRefusedEvent { Type = AcceptRefusedEventType.AcceptRefused, DeliveryId = refusal.DeliveryId, Reason = refusal.Reason }.ToJson());
    runner.ReportRecorded += receipt =>
        Emit(new ReportRecordedEvent { Type = ReportRecordedEventType.ReportRecorded, DeliveryId = receipt.DeliveryId, Late = receipt.Late }.ToJson());
    runner.ReportRejected += rejection =>
        Emit(new ReportRejectedEvent { Type = ReportRejectedEventType.ReportRejected, DeliveryId = rejection.DeliveryId, Reason = rejection.Reason }.ToJson());
    runner.Faulted += fault => Fail(fault.ToString());

    try
    {
        await runner.ConnectAsync();
    }
    catch (ConnectFailedException failure)
    {
        Emit(new ConnectFailedEvent { Type = ConnectFailedEventType.ConnectFailed, Reason = failure.Reason }.ToJson());
    }

    return runner;
}

async Task ReportPendingAsync(RunnerClient runner, ReportPendingCommand command)
{
    var outcome = command.Outcome.Err is { } error ? Outcome.Err(error) : Outcome.Ok(command.Outcome.Ok);
    try
    {
        var receipt = await runner.ReportPendingAsync(command.DeliveryId, outcome);
        Emit(new ReportRecordedEvent { Type = ReportRecordedEventType.ReportRecorded, DeliveryId = receipt.DeliveryId, Late = receipt.Late }.ToJson());
    }
    catch (ReportRejectedException rejection)
    {
        Emit(new ReportRejectedEvent { Type = ReportRejectedEventType.ReportRejected, DeliveryId = rejection.DeliveryId, Reason = rejection.Reason }.ToJson());
    }
    catch (Exception ex)
    {
        Fail(ex.Message);
    }
}

// The default store, plus the two wrappers the suite asks for through the same interface.
static ISecretStore StoreFor(SecretStoreConfig config)
{
    var file = new FileSecretStore(config.Directory);
    return config.Kind switch
    {
        SecretStoreKindEnum.File => file,
        SecretStoreKindEnum.Tampered => new TamperedStore(file),
        SecretStoreKindEnum.Retaining => new RetainingStore(file),
        var other => throw new InvalidOperationException($"unknown secret store kind {other}"),
    };
}

internal sealed class TamperedStore(ISecretStore inner) : ISecretStore
{
    public ValueTask SaveAsync(Guid deliveryId, string secret, CancellationToken cancellationToken) => inner.SaveAsync(deliveryId, secret, cancellationToken);

    public async ValueTask<string?> LoadAsync(Guid deliveryId, CancellationToken cancellationToken) =>
        await inner.LoadAsync(deliveryId, cancellationToken) is { } secret ? secret + "-tampered" : null;

    public ValueTask RemoveAsync(Guid deliveryId, CancellationToken cancellationToken) => inner.RemoveAsync(deliveryId, cancellationToken);

    public ValueTask<IReadOnlyList<Guid>> PendingAsync(CancellationToken cancellationToken) => inner.PendingAsync(cancellationToken);
}

internal sealed class RetainingStore(ISecretStore inner) : ISecretStore
{
    public ValueTask SaveAsync(Guid deliveryId, string secret, CancellationToken cancellationToken) => inner.SaveAsync(deliveryId, secret, cancellationToken);

    public ValueTask<string?> LoadAsync(Guid deliveryId, CancellationToken cancellationToken) => inner.LoadAsync(deliveryId, cancellationToken);

    public ValueTask RemoveAsync(Guid deliveryId, CancellationToken cancellationToken) => ValueTask.CompletedTask;

    public ValueTask<IReadOnlyList<Guid>> PendingAsync(CancellationToken cancellationToken) => inner.PendingAsync(cancellationToken);
}
