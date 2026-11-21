namespace Cruma.Tron.Runner;

/// <summary>One run Tron pushed to this runner. It carries ids, the job's name and times, never a payload.</summary>
/// <param name="DeliveryId">Names this delivery; reports are made against it.</param>
/// <param name="RunId">The run this delivery belongs to.</param>
/// <param name="JobId">The job that was triggered.</param>
/// <param name="JobName">The job's name, as its owner set it.</param>
/// <param name="ScheduledFor">When the run was due.</param>
/// <param name="AcceptDeadline">The time by which Tron must receive the acceptance.</param>
public sealed record Delivery(
    Guid DeliveryId,
    Guid RunId,
    Guid JobId,
    string JobName,
    DateTimeOffset ScheduledFor,
    DateTimeOffset AcceptDeadline);

/// <summary>Tron's acknowledgement that a report was recorded.</summary>
/// <param name="DeliveryId">The reported delivery.</param>
/// <param name="Late">True when the report arrived after the job's lateness threshold; it is still recorded.</param>
public sealed record ReportReceipt(Guid DeliveryId, bool Late);

/// <summary>A handler: runs one delivery and returns its <see cref="Outcome"/>.</summary>
/// <param name="delivery">The delivery to run. It has already been accepted and its secret persisted.</param>
/// <param name="cancellationToken">Cancelled when a graceful stop is abandoned or the client is disposed.</param>
public delegate Task<Outcome> RunnerHandler(Delivery delivery, CancellationToken cancellationToken);
