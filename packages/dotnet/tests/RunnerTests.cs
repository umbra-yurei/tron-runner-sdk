using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
// docs:start
using Cruma.Tron.Runner;
// docs:end
using Cruma.Tron.Runner.Generated;
using Xunit;

namespace Cruma.Tron.Runner.Tests;

public sealed class ProtocolTests
{
    [Fact]
    public void AnnouncesTheGeneratedProtocolVersion()
    {
        Assert.Equal("v1", ProtocolVersion.Current);
        Assert.Equal(RunnerProtocolVersionEnum.V1, RunnerClient.SupportedProtocolVersion);
    }

    [Fact]
    public void SdkVersionIsASemanticVersionWithoutBuildMetadata()
    {
        Assert.True(Version.TryParse(RunnerClient.SdkVersion.Split('-')[0], out _), RunnerClient.SdkVersion);
        Assert.DoesNotContain('+', RunnerClient.SdkVersion);
    }

    [Theory]
    [InlineData("http://127.0.0.1:8090", "ws://127.0.0.1:8090/api/runners/ws")]
    [InlineData("https://tron.example.com", "wss://tron.example.com/api/runners/ws")]
    [InlineData("https://tron.example.com/prefix/", "wss://tron.example.com/prefix/api/runners/ws")]
    [InlineData("ws://localhost:9000", "ws://localhost:9000/api/runners/ws")]
    public void TheChannelPathComesFromTheGeneratedAddress(string baseUrl, string expected)
    {
        Assert.Equal(ProtocolVersion.ChannelAddress, "/api/runners/ws");
        Assert.Equal(expected, RunnerClient.ChannelUriFor(new Uri(baseUrl)).ToString());
    }

    [Fact]
    public void OutcomesSerializeAsExactlyOneOfOkOrErr()
    {
        var ok = Outcome.Ok("fine").ToWire();
        Assert.Equal("fine", ok.Ok);
        Assert.Null(ok.Err);

        var err = Outcome.Err("broke").ToWire();
        Assert.Equal("broke", err.Err);
        Assert.Null(err.Ok);
    }

    [Fact]
    public async Task ConnectingToNothingIsATypedUnreachableError()
    {
        await using var client = new RunnerClient(new RunnerClientOptions
        {
            TronUrl = new Uri("http://127.0.0.1:1"),
            Token = "x",
            SecretStore = new MemoryStore(),
        });
        client.Handle("h", (_, _) => Task.FromResult(Outcome.Ok("ok")));
        var failure = await Assert.ThrowsAsync<ConnectFailedException>(() => client.ConnectAsync());
        Assert.Equal(ConnectFailureEnum.Unreachable, failure.Reason);
    }

    [Fact]
    public async Task ConnectingWithoutAHandlerIsRefused()
    {
        await using var client = new RunnerClient(new RunnerClientOptions { TronUrl = new Uri("http://127.0.0.1:1"), Token = "x", SecretStore = new MemoryStore() });
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.ConnectAsync());
    }

    private sealed class MemoryStore : ISecretStore
    {
        public ValueTask SaveAsync(Guid deliveryId, string secret, CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<string?> LoadAsync(Guid deliveryId, CancellationToken cancellationToken) => ValueTask.FromResult<string?>(null);

        public ValueTask RemoveAsync(Guid deliveryId, CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<IReadOnlyList<Guid>> PendingAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<Guid>>([]);
    }
}

public sealed class FileSecretStoreTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "tron-sdk-" + Guid.NewGuid().ToString("N"));

    public void Dispose() => Directory.Delete(directory, recursive: true);

    [Fact]
    public async Task SavesLoadsListsAndRemoves()
    {
        var store = new FileSecretStore(directory);
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        Assert.Null(await store.LoadAsync(first, default));

        await store.SaveAsync(first, "s3cret", default);
        await store.SaveAsync(second, "other", default);
        await store.SaveAsync(second, "replaced", default);

        Assert.Equal("s3cret", await store.LoadAsync(first, default));
        Assert.Equal("replaced", await store.LoadAsync(second, default));
        Assert.Equal(new[] { first, second }.Order(), (await store.PendingAsync(default)).Order());

        await store.RemoveAsync(first, default);
        await store.RemoveAsync(first, default);
        Assert.Equal(new[] { second }, await store.PendingAsync(default));
    }

    [Fact]
    public async Task SecretFilesAreReadableOnlyByTheirOwner()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var store = new FileSecretStore(directory);
        var deliveryId = Guid.NewGuid();
        await store.SaveAsync(deliveryId, "s3cret", default);

        var file = Directory.GetFiles(directory).Single();
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(directory));
    }

    [Fact]
    public void AnExistingDirectoryOthersCanAccessIsRefusedAndLeftAlone()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        const UnixFileMode permissive = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;
        Directory.CreateDirectory(directory);
        File.SetUnixFileMode(directory, permissive);

        var refusal = Assert.Throws<InsecureSecretDirectoryException>(() => new FileSecretStore(directory));
        Assert.Equal(permissive, refusal.Mode);
        Assert.Equal(permissive, File.GetUnixFileMode(directory));
    }

    [Fact]
    public async Task AnExistingPrivateDirectoryIsAccepted()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        Directory.CreateDirectory(directory);
        File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var store = new FileSecretStore(directory);
        await store.SaveAsync(Guid.NewGuid(), "s3cret", default);
        Assert.Single(await store.PendingAsync(default));
    }

    [Fact]
    public async Task APendingSecretSurvivesANewStoreOverTheSameDirectory()
    {
        var deliveryId = Guid.NewGuid();
        await new FileSecretStore(directory).SaveAsync(deliveryId, "s3cret", default);

        var restarted = new FileSecretStore(directory);
        Assert.Equal(new[] { deliveryId }, await restarted.PendingAsync(default));
        Assert.Equal("s3cret", await restarted.LoadAsync(deliveryId, default));
    }
}

public sealed class DocumentedExampleTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "tron-sdk-" + Guid.NewGuid().ToString("N"));
    private HttpListener? listener;
    private Task? serverTask;
    private readonly Guid deliveryId = Guid.Parse("5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01");
    private const string Secret = "the-secret";
    private readonly TaskCompletionSource reportReceived = new();

    public async Task InitializeAsync()
    {
        listener = new HttpListener();
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();

        Environment.SetEnvironmentVariable("TRON_URL", $"http://127.0.0.1:{port}");
        Environment.SetEnvironmentVariable("TRON_WORKER_KEY", "documented-key");
        Environment.SetEnvironmentVariable("TRON_SECRET_DIR", directory);

        serverTask = RunMockTronAsync(listener);
        await Task.Yield();
    }

    public async Task DisposeAsync()
    {
        reportReceived.TrySetCanceled();
        listener?.Stop();
        listener?.Close();
        if (serverTask is not null)
        {
            await serverTask;
        }

        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
        }

        Environment.SetEnvironmentVariable("TRON_URL", null);
        Environment.SetEnvironmentVariable("TRON_WORKER_KEY", null);
        Environment.SetEnvironmentVariable("TRON_SECRET_DIR", null);
    }

    [Fact]
    public async Task DocumentedExampleRunsADeliveryAndReportsIt()
    {
        // docs:start
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
        // docs:hide
        await reportReceived.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // docs:show
        await runner.StopAsync(); // finish in-flight work, report it, then close
        // docs:end
    }

    private async Task RunMockTronAsync(HttpListener listener)
    {
        try
        {
            while (listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync().ConfigureAwait(false);
                }
                catch (ObjectDisposedException)
                {
                    break;
                }

                if (!context.Request.IsWebSocketRequest)
                {
                    context.Response.StatusCode = 404;
                    context.Response.Close();
                    continue;
                }

                try
                {
                    var wsContext = await context.AcceptWebSocketAsync(null).ConfigureAwait(false);
                    var ws = wsContext.WebSocket;
                    await HandleClientAsync(ws).ConfigureAwait(false);
                }
                catch
                {
                    context.Response.StatusCode = 500;
                    context.Response.Close();
                }
            }
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private async Task HandleClientAsync(WebSocket ws)
    {
        try
        {
            using (ws)
            {
                // Read authenticate frame
                var auth = await ReadFrameAsync<AuthenticateFrame>(ws);
                Assert.NotNull(auth);

                // Send authenticated
                var authenticated = new AuthenticatedFrame
                {
                    Type = AuthenticatedFrameType.Authenticated,
                    SessionId = Guid.Parse("00000000-0000-0000-0000-000000000123"),
                };
                await SendFrameAsync(ws, authenticated);

                // Read announce frame
                var announce = await ReadFrameAsync<AnnounceFrame>(ws);
                Assert.NotNull(announce);
                Assert.Equal(new[] { "send-report" }, announce.Announcement.HandlerKeys);

                // Send announced
                var announced = new AnnouncedFrame { Type = AnnouncedFrameType.Announced };
                await SendFrameAsync(ws, announced);

                // Send work
                var work = new WorkFrame
                {
                    Type = WorkFrameType.Work,
                    DeliveryId = deliveryId,
                    JobId = Guid.Parse("00000000-0000-0000-0000-000000000789"),
                    HandlerKey = "send-report",
                    JobName = "nightly",
                    RunId = Guid.Parse("00000000-0000-0000-0000-000000000456"),
                    ScheduledFor = DateTime.UtcNow.ToString("O"),
                    AcceptDeadline = DateTime.UtcNow.AddSeconds(30).ToString("O"),
                };
                await SendFrameAsync(ws, work);

                // Read accept frame
                var accept = await ReadFrameAsync<AcceptFrame>(ws);
                Assert.NotNull(accept);

                // Send accepted
                var accepted = new AcceptedFrame
                {
                    Type = AcceptedFrameType.Accepted,
                    DeliveryId = deliveryId,
                    Secret = Secret,
                };
                await SendFrameAsync(ws, accepted);

                // Read report frame
                var report = await ReadFrameAsync<ReportFrame>(ws);
                Assert.NotNull(report);
                Assert.Equal(Secret, report.Secret);
                Assert.Equal("sent the report for nightly", report.Outcome.Ok);

                reportReceived.TrySetResult();

                // Send report recorded
                var recorded = new ReportRecordedFrame
                {
                    Type = ReportRecordedEventType.ReportRecorded,
                    DeliveryId = deliveryId,
                    Late = false,
                };
                await SendFrameAsync(ws, recorded);
            }
        }
        catch (Exception ex)
        {
            reportReceived.TrySetException(ex);
        }
    }

    private static async Task<T?> ReadFrameAsync<T>(WebSocket ws)
    {
        var buffer = new byte[16 * 1024];
        var received = await ws.ReceiveAsync(buffer, default);
        if (received.MessageType != WebSocketMessageType.Text)
        {
            throw new InvalidOperationException("Expected text frame");
        }

        var json = Encoding.UTF8.GetString(buffer, 0, received.Count);
        return (T?)JsonSerializer.Deserialize(json, typeof(T), Converter.Settings);
    }

    private static async Task SendFrameAsync(WebSocket ws, object frame)
    {
        var json = JsonSerializer.Serialize(frame, frame.GetType(), Converter.Settings);
        var bytes = Encoding.UTF8.GetBytes(json);
        await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, default);
    }
}
