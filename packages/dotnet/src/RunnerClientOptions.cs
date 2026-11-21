namespace Cruma.Tron.Runner;

/// <summary>How a <see cref="RunnerClient"/> connects and announces itself.</summary>
public sealed class RunnerClientOptions
{
    /// <summary>Tron's base URL (<c>https://tron.example.com</c>); the runner channel's path is appended by the SDK.</summary>
    public required Uri TronUrl { get; init; }

    /// <summary>A worker API key token, shown once when the key is created on the Runners page.</summary>
    public required string Token { get; init; }

    /// <summary>How much work Tron may push to this session at once; must be positive. Handlers run concurrently up to it.</summary>
    public int ConcurrencyCapacity { get; init; } = 1;

    /// <summary>Optional name shown to the owner next to this runner.</summary>
    public string? DisplayName { get; init; }

    /// <summary>Optional version of the program using the SDK, shown to the owner.</summary>
    public string? RunnerVersion { get; init; }

    /// <summary>Where delivery secrets are kept; defaults to a <see cref="FileSecretStore"/> in <see cref="SecretDirectory"/>.</summary>
    public ISecretStore? SecretStore { get; init; }

    /// <summary>The directory of the default <see cref="FileSecretStore"/>; required when no <see cref="SecretStore"/> is given.</summary>
    public string? SecretDirectory { get; init; }

    /// <summary>The first wait before reconnecting; it doubles after each failed attempt.</summary>
    public TimeSpan ReconnectInitialDelay { get; init; } = TimeSpan.FromMilliseconds(100);

    /// <summary>The longest wait between reconnect attempts.</summary>
    public TimeSpan ReconnectMaxDelay { get; init; } = TimeSpan.FromSeconds(5);
}
