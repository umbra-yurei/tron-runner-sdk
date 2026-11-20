using System.Globalization;

namespace Cruma.Tron.Runner;

/// <summary>One file per delivery in a caller-chosen directory, readable only by the current user (0600 on Unix).</summary>
public sealed class FileSecretStore : ISecretStore
{
    private const string Extension = ".secret";
    private const string TemporaryExtension = ".tmp";
    private const UnixFileMode PrivateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    private readonly string directory;

    public FileSecretStore(string directory)
    {
        this.directory = Path.GetFullPath(directory);
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(this.directory);
        }
        else
        {
            Directory.CreateDirectory(this.directory, PrivateDirectory);
        }
    }

    public async ValueTask SaveAsync(Guid deliveryId, string secret, CancellationToken cancellationToken)
    {
        var target = PathFor(deliveryId);
        var temporary = $"{target}.{Guid.NewGuid():N}{TemporaryExtension}";
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = PrivateFile;
        }

        try
        {
            await using (var stream = new FileStream(temporary, options))
            {
                await using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false));
                await writer.WriteAsync(secret.AsMemory(), cancellationToken).ConfigureAwait(false);
                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporary, target, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    public async ValueTask<string?> LoadAsync(Guid deliveryId, CancellationToken cancellationToken)
    {
        try
        {
            return await File.ReadAllTextAsync(PathFor(deliveryId), cancellationToken).ConfigureAwait(false);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
    }

    public ValueTask RemoveAsync(Guid deliveryId, CancellationToken cancellationToken)
    {
        File.Delete(PathFor(deliveryId));
        return ValueTask.CompletedTask;
    }

    public ValueTask<IReadOnlyList<Guid>> PendingAsync(CancellationToken cancellationToken)
    {
        var pending = new List<Guid>();
        foreach (var file in Directory.EnumerateFiles(directory, "*" + Extension))
        {
            if (Guid.TryParseExact(Path.GetFileNameWithoutExtension(file), "D", out var deliveryId))
            {
                pending.Add(deliveryId);
            }
        }

        return ValueTask.FromResult<IReadOnlyList<Guid>>(pending);
    }

    private string PathFor(Guid deliveryId) =>
        Path.Combine(directory, deliveryId.ToString("D", CultureInfo.InvariantCulture) + Extension);
}
