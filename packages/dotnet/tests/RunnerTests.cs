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
