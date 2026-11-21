namespace Cruma.Tron.Runner;

/// <summary>
/// Where the one-time delivery secret Tron returns on acceptance is kept until the report is recorded.
/// It is the only state that survives a restart. <see cref="FileSecretStore"/> is the default; implement this to use
/// a database or secret manager.
/// </summary>
public interface ISecretStore
{
    /// <summary>Persists the secret durably; the SDK calls this before it runs the handler.</summary>
    ValueTask SaveAsync(Guid deliveryId, string secret, CancellationToken cancellationToken);

    /// <summary>The stored secret, or null when there is none.</summary>
    ValueTask<string?> LoadAsync(Guid deliveryId, CancellationToken cancellationToken);

    /// <summary>Deletes the secret; removing an absent one is not an error.</summary>
    ValueTask RemoveAsync(Guid deliveryId, CancellationToken cancellationToken);

    /// <summary>The deliveries that were accepted and have not been reported.</summary>
    ValueTask<IReadOnlyList<Guid>> PendingAsync(CancellationToken cancellationToken);
}
