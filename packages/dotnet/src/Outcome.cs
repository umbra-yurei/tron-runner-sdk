using Cruma.Tron.Runner.Generated;

namespace Cruma.Tron.Runner;

/// <summary>What a handler finished with: <see cref="Ok"/> or <see cref="Err"/>, each carrying a message.</summary>
public sealed record Outcome
{
    private Outcome(bool isOk, string message)
    {
        IsOk = isOk;
        Message = message;
    }

    /// <summary>True for <see cref="Ok"/>, false for <see cref="Err"/>.</summary>
    public bool IsOk { get; }

    /// <summary>The message Tron records with the run.</summary>
    public string Message { get; }

    /// <summary>The run succeeded.</summary>
    public static Outcome Ok(string message) => new(true, message);

    /// <summary>The run failed.</summary>
    public static Outcome Err(string message) => new(false, message);

    internal RunOutcome ToWire() => IsOk ? new RunOutcome { Ok = Message } : new RunOutcome { Err = Message };
}
