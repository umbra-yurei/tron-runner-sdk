using Cruma.Tron.Runner.Generated;

namespace Cruma.Tron.Runner;

/// <summary>Base of every typed error the SDK raises.</summary>
public abstract class TronRunnerException : Exception
{
    protected TronRunnerException(string message, Exception? inner = null) : base(message, inner)
    {
    }
}

/// <summary>Connecting failed. <see cref="Reason"/> is the closed set from the protocol; it is never parsed from text.</summary>
public sealed class ConnectFailedException : TronRunnerException
{
    public ConnectFailedException(ConnectFailureEnum reason, Exception? inner = null)
        : base($"connecting to Tron failed: {reason}", inner) => Reason = reason;

    public ConnectFailureEnum Reason { get; }
}

/// <summary>Tron refused an <c>accept</c>; the handler was not run.</summary>
public sealed class AcceptRefusedException : TronRunnerException
{
    public AcceptRefusedException(Guid deliveryId, AcceptRefusalEnum reason)
        : base($"Tron refused to accept delivery {deliveryId}: {reason}")
    {
        DeliveryId = deliveryId;
        Reason = reason;
    }

    public Guid DeliveryId { get; }

    public AcceptRefusalEnum Reason { get; }
}

/// <summary>Tron rejected a report. It is not retried and the stored secret is kept.</summary>
public sealed class ReportRejectedException : TronRunnerException
{
    public ReportRejectedException(Guid deliveryId, ReportRejectionEnum reason)
        : base($"Tron rejected the report for delivery {deliveryId}: {reason}")
    {
        DeliveryId = deliveryId;
        Reason = reason;
    }

    public Guid DeliveryId { get; }

    public ReportRejectionEnum Reason { get; }
}

/// <summary>Tron answered a frame this runner sent with <c>protocol_error</c>.</summary>
public sealed class ProtocolViolationException : TronRunnerException
{
    public ProtocolViolationException(ProtocolViolationEnum reason)
        : base($"Tron reported a protocol violation: {reason}") => Reason = reason;

    public ProtocolViolationEnum Reason { get; }
}

/// <summary>The secret store holds no secret for a delivery, so it cannot be reported.</summary>
public sealed class MissingSecretException : TronRunnerException
{
    public MissingSecretException(Guid deliveryId)
        : base($"no secret is stored for delivery {deliveryId}") => DeliveryId = deliveryId;

    public Guid DeliveryId { get; }
}

/// <summary>
/// Work arrived for a runner that registered more than one handler. Protocol v1 does not say which handler a
/// <c>work</c> frame is for, so the SDK refuses to guess: the delivery is not accepted.
/// </summary>
public sealed class HandlerRoutingException : TronRunnerException
{
    public HandlerRoutingException(Guid deliveryId, int handlerCount)
        : base($"delivery {deliveryId} cannot be routed: {handlerCount} handlers are registered and protocol v1 work frames carry no handler key")
        => DeliveryId = deliveryId;

    public Guid DeliveryId { get; }
}

/// <summary>The secret directory already exists and group or others can access it, so secrets stored there would not be private.</summary>
public sealed class InsecureSecretDirectoryException : TronRunnerException
{
    public InsecureSecretDirectoryException(string directory, UnixFileMode mode)
        : base($"secret directory {directory} has mode {Convert.ToString((int)mode, 8)}; group and others must have no access (use chmod 700 or choose another directory)")
    {
        Directory = directory;
        Mode = mode;
    }

    /// <summary>The refused directory.</summary>
    public string Directory { get; }

    /// <summary>Its permissions.</summary>
    public UnixFileMode Mode { get; }
}
