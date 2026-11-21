using System.Globalization;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using Cruma.Tron.Runner.Generated;

namespace Cruma.Tron.Runner;

/// <summary>
/// A Tron runner: it connects with a worker API key, announces its handlers, accepts the work Tron pushes, runs the
/// handler, and reports <see cref="Outcome.Ok"/> or <see cref="Outcome.Err"/>. A lost connection is re-established
/// automatically with exponential backoff; the delivery secret is persisted before a handler runs, so a delivery can
/// still be reported by a restarted process (<see cref="ReportPendingAsync"/>).
/// </summary>
public sealed class RunnerClient : IAsyncDisposable
{
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(2);

    private readonly RunnerClientOptions options;
    private readonly ISecretStore store;
    private readonly Uri channelUri;
    private readonly Dictionary<string, RunnerHandler> handlers = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly HashSet<Guid> unanswered = new();
    private readonly Dictionary<Guid, Delivery> awaitingAcceptance = new();
    private readonly Dictionary<Guid, TaskCompletionSource<ReportReceipt>> reportWaiters = new();
    private readonly TaskCompletionSource firstOutcome = NewSignal();
    private readonly CancellationTokenSource loopCts = new();
    private readonly CancellationTokenSource handlerCts = new();
    private TaskCompletionSource idle = NewSignal();
    private TaskCompletionSource<Session> currentSession = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Task? loopTask;
    private bool started;
    private volatile bool stopping;
    private bool connectedOnce;
    private TimeSpan reconnectDelay;

    /// <summary>Creates a runner; register handlers with <see cref="Handle"/>, then call <see cref="ConnectAsync"/>.</summary>
    public RunnerClient(RunnerClientOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.ConcurrencyCapacity < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "ConcurrencyCapacity must be positive");
        }

        this.options = options;
        store = options.SecretStore
            ?? new FileSecretStore(options.SecretDirectory
                ?? throw new ArgumentException("either SecretStore or SecretDirectory is required", nameof(options)));
        channelUri = ChannelUriFor(options.TronUrl);
        reconnectDelay = options.ReconnectInitialDelay;
    }

    /// <summary>The semantic version of this package, announced to Tron.</summary>
    public static string SdkVersion { get; } = ReadSdkVersion();

    /// <summary>The protocol version this package speaks, from the generated <see cref="ProtocolVersion.Current"/>.</summary>
    public static RunnerProtocolVersionEnum SupportedProtocolVersion { get; } =
        RunnerProtocolVersion.FromJson(ProtocolVersion.Current.ToJson());

    /// <summary>A new session was established and announced (also after every reconnect).</summary>
    public event Action<Guid>? SessionStarted;

    /// <summary>Tron accepted a delivery and its secret was persisted; the handler is about to run.</summary>
    public event Action<Guid>? DeliveryAccepted;

    /// <summary>Tron refused an acceptance; the handler was not run.</summary>
    public event Action<AcceptRefusedException>? AcceptRefused;

    /// <summary>A handler's report was recorded and its secret deleted.</summary>
    public event Action<ReportReceipt>? ReportRecorded;

    /// <summary>A handler's report was rejected; it is not retried and the secret is kept.</summary>
    public event Action<ReportRejectedException>? ReportRejected;

    /// <summary>
    /// Something failed outside the typed paths above: an undecodable frame, a protocol violation, work that cannot be
    /// routed, a secret store failure, or an authentication failure on a reconnect (which ends the runner).
    /// </summary>
    public event Action<Exception>? Faulted;

    /// <summary>Registers an async handler for a job's handler key; the registered keys are what is announced.</summary>
    public RunnerClient Handle(string handlerKey, RunnerHandler handler)
    {
        ArgumentException.ThrowIfNullOrEmpty(handlerKey);
        ArgumentNullException.ThrowIfNull(handler);
        lock (gate)
        {
            if (started)
            {
                throw new InvalidOperationException("handlers must be registered before ConnectAsync");
            }

            if (!handlers.TryAdd(handlerKey, handler))
            {
                throw new ArgumentException($"a handler for '{handlerKey}' is already registered", nameof(handlerKey));
            }
        }

        return this;
    }

    /// <summary>
    /// Connects, authenticates and announces. Throws <see cref="ConnectFailedException"/> when the first attempt cannot:
    /// <c>Unreachable</c> at the transport, <c>AuthenticationFailed</c> for a bad token, <c>AnnouncementRejected</c>
    /// when Tron refuses the announcement. These are not retried. Once connected, later losses are retried silently.
    /// </summary>
    public async Task ConnectAsync(CancellationToken cancellationToken = default)
    {
        lock (gate)
        {
            if (started)
            {
                throw new InvalidOperationException("ConnectAsync was already called");
            }

            if (handlers.Count == 0)
            {
                throw new InvalidOperationException("register at least one handler before ConnectAsync");
            }

            started = true;
        }

        loopTask = Task.Run(RunLoopAsync, CancellationToken.None);
        try
        {
            await firstOutcome.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await ShutdownAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>
    /// Stops taking new work, waits for in-flight handlers and for Tron to answer their reports, then closes the
    /// connection. Cancelling <paramref name="cancellationToken"/> abandons the wait: handlers are cancelled, the
    /// connection is closed and the unreported secrets stay in the store.
    /// </summary>
    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        stopping = true;
        try
        {
            await WaitIdle().WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            handlerCts.Cancel();
            await ShutdownAsync().ConfigureAwait(false);
            throw;
        }

        await ShutdownAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Reports an accepted delivery from the secret store, for example after a restart. Returns once Tron recorded it;
    /// throws <see cref="ReportRejectedException"/> when Tron rejects it, <see cref="MissingSecretException"/> when the
    /// store has no secret.
    /// </summary>
    public async Task<ReportReceipt> ReportPendingAsync(Guid deliveryId, Outcome outcome, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(outcome);
        if (!Begin(deliveryId))
        {
            throw new InvalidOperationException($"delivery {deliveryId} is already in progress");
        }

        try
        {
            return await ReportAsync(deliveryId, outcome, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            End(deliveryId);
        }
    }

    /// <summary>The deliveries accepted and not yet reported, according to the secret store.</summary>
    public ValueTask<IReadOnlyList<Guid>> PendingDeliveriesAsync(CancellationToken cancellationToken = default) =>
        store.PendingAsync(cancellationToken);

    /// <summary>Stops immediately: running handlers are cancelled and the connection is closed.</summary>
    public async ValueTask DisposeAsync()
    {
        stopping = true;
        handlerCts.Cancel();
        await ShutdownAsync().ConfigureAwait(false);
        loopCts.Dispose();
        handlerCts.Dispose();
    }

    internal static Uri ChannelUriFor(Uri tronUrl)
    {
        var scheme = tronUrl.Scheme switch
        {
            "http" or "ws" => "ws",
            "https" or "wss" => "wss",
            var other => throw new ArgumentException($"unsupported Tron URL scheme '{other}'", nameof(tronUrl)),
        };
        var builder = new UriBuilder(tronUrl) { Scheme = scheme, Path = tronUrl.AbsolutePath.TrimEnd('/') + ProtocolVersion.ChannelAddress, Query = string.Empty, Fragment = string.Empty };
        if (builder.Uri.IsDefaultPort)
        {
            builder.Port = -1;
        }

        return builder.Uri;
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static string ReadSdkVersion()
    {
        var informational = typeof(RunnerClient).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? "0.0.0";
        var metadata = informational.IndexOf('+', StringComparison.Ordinal);
        return metadata < 0 ? informational : informational[..metadata];
    }

    private async Task ShutdownAsync()
    {
        loopCts.Cancel();
        if (loopTask is not null)
        {
            await loopTask.ConfigureAwait(false);
        }
    }

    private async Task RunLoopAsync()
    {
        var token = loopCts.Token;
        Exception? terminal = null;
        try
        {
            while (!token.IsCancellationRequested)
            {
                using var socket = new ClientWebSocket();
                var session = new Session(socket);
                try
                {
                    await socket.ConnectAsync(channelUri, token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex) when (ex is WebSocketException or HttpRequestException or IOException)
                {
                    if (!connectedOnce)
                    {
                        terminal = new ConnectFailedException(ConnectFailureEnum.Unreachable, ex);
                        return;
                    }

                    await BackOffAsync(token).ConfigureAwait(false);
                    continue;
                }

                try
                {
                    await ServeAsync(session, token).ConfigureAwait(false);
                    if (!connectedOnce)
                    {
                        terminal = new ConnectFailedException(ConnectFailureEnum.Unreachable);
                        return;
                    }
                }
                catch (ConnectFailedException ex)
                {
                    terminal = ex;
                    return;
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex) when (ex is WebSocketException or IOException)
                {
                    if (!connectedOnce)
                    {
                        terminal = new ConnectFailedException(ConnectFailureEnum.Unreachable, ex);
                        return;
                    }
                }
                catch (Exception ex)
                {
                    Fault(ex);
                }
                finally
                {
                    Retire(session);
                    await CloseQuietlyAsync(socket).ConfigureAwait(false);
                }

                await BackOffAsync(token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
        }
        finally
        {
            lock (gate)
            {
                if (terminal is null)
                {
                    currentSession.TrySetCanceled();
                }
                else
                {
                    currentSession.TrySetException(terminal);
                }
            }

            if (terminal is not null)
            {
                if (connectedOnce)
                {
                    Fault(terminal);
                }

                firstOutcome.TrySetException(terminal);
            }
            else
            {
                firstOutcome.TrySetCanceled();
            }
        }
    }

    private async Task BackOffAsync(CancellationToken token)
    {
        await Task.Delay(reconnectDelay, token).ConfigureAwait(false);
        reconnectDelay = TimeSpan.FromTicks(Math.Min(reconnectDelay.Ticks * 2, options.ReconnectMaxDelay.Ticks));
    }

    private static async Task CloseQuietlyAsync(ClientWebSocket socket)
    {
        using var timeout = new CancellationTokenSource(CloseTimeout);
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException or ObjectDisposedException)
        {
        }
    }

    private async Task ServeAsync(Session session, CancellationToken token)
    {
        await session.SendAsync(new AuthenticateFrame { Type = AuthenticateFrameType.Authenticate, Token = options.Token }.ToJson(), token)
            .ConfigureAwait(false);
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            message.SetLength(0);
            ValueWebSocketReceiveResult received;
            do
            {
                received = await session.Socket.ReceiveAsync(buffer.AsMemory(), token).ConfigureAwait(false);
                if (received.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }

                message.Write(buffer, 0, received.Count);
            }
            while (!received.EndOfMessage);

            if (received.MessageType != WebSocketMessageType.Text)
            {
                Fault(new InvalidDataException("Tron sent a binary frame"));
                continue;
            }

            await OnFrameAsync(session, Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length), token).ConfigureAwait(false);
        }
    }

    private async Task OnFrameAsync(Session session, string text, CancellationToken token)
    {
        ServerFrameKindEnum kind;
        try
        {
            kind = ServerFrameTag.FromJson(text).Type;
        }
        catch (Exception ex)
        {
            Fault(new InvalidDataException("Tron sent a frame that is not part of the protocol", ex));
            return;
        }

        switch (kind)
        {
            case ServerFrameKindEnum.Authenticated:
                session.Id = AuthenticatedFrame.FromJson(text).SessionId;
                await session.SendAsync(AnnouncementFrame(), token).ConfigureAwait(false);
                break;
            case ServerFrameKindEnum.Announced:
                connectedOnce = true;
                reconnectDelay = options.ReconnectInitialDelay;
                Publish(session);
                Raise(SessionStarted, session.Id);
                firstOutcome.TrySetResult();
                break;
            case ServerFrameKindEnum.AuthenticationFailed:
                throw new ConnectFailedException(ConnectFailureEnum.AuthenticationFailed);
            case ServerFrameKindEnum.ProtocolError:
                var violation = new ProtocolViolationException(ProtocolErrorFrame.FromJson(text).Reason);
                if (!connectedOnce)
                {
                    throw new ConnectFailedException(ConnectFailureEnum.AnnouncementRejected, violation);
                }

                Fault(violation);
                break;
            case ServerFrameKindEnum.Work:
                await OnWorkAsync(session, WorkFrame.FromJson(text), token).ConfigureAwait(false);
                break;
            case ServerFrameKindEnum.Accepted:
                await OnAcceptedAsync(AcceptedFrame.FromJson(text), token).ConfigureAwait(false);
                break;
            case ServerFrameKindEnum.AcceptRefused:
                var refused = AcceptRefusedFrame.FromJson(text);
                lock (gate)
                {
                    awaitingAcceptance.Remove(refused.DeliveryId);
                }

                Raise(AcceptRefused, new AcceptRefusedException(refused.DeliveryId, refused.Reason));
                End(refused.DeliveryId);
                break;
            case ServerFrameKindEnum.ReportRecorded:
                var recorded = ReportRecordedFrame.FromJson(text);
                CompleteReport(recorded.DeliveryId, waiter => waiter.TrySetResult(new ReportReceipt(recorded.DeliveryId, recorded.Late)));
                break;
            case ServerFrameKindEnum.ReportRejected:
                var rejected = ReportRejectedFrame.FromJson(text);
                CompleteReport(rejected.DeliveryId, waiter => waiter.TrySetException(new ReportRejectedException(rejected.DeliveryId, rejected.Reason)));
                break;
        }
    }

    private string AnnouncementFrame() =>
        new AnnounceFrame
        {
            Type = AnnounceFrameType.Announce,
            Announcement = new RunnerAnnouncement
            {
                ConcurrencyCapacity = options.ConcurrencyCapacity,
                DisplayName = options.DisplayName,
                HandlerKeys = handlers.Keys.Order(StringComparer.Ordinal).ToList(),
                ProtocolVersion = SupportedProtocolVersion,
                RunnerVersion = options.RunnerVersion,
                SdkVersion = SdkVersion,
            },
        }.ToJson();

    private async Task OnWorkAsync(Session session, WorkFrame frame, CancellationToken token)
    {
        if (stopping)
        {
            return;
        }

        if (handlers.Count != 1)
        {
            Fault(new HandlerRoutingException(frame.DeliveryId, handlers.Count));
            return;
        }

        var delivery = new Delivery(
            frame.DeliveryId,
            frame.RunId,
            frame.JobId,
            frame.JobName,
            DateTimeOffset.Parse(frame.ScheduledFor, CultureInfo.InvariantCulture),
            DateTimeOffset.Parse(frame.AcceptDeadline, CultureInfo.InvariantCulture));
        if (!Begin(delivery.DeliveryId))
        {
            return;
        }

        lock (gate)
        {
            awaitingAcceptance[delivery.DeliveryId] = delivery;
        }

        await session.SendAsync(new AcceptFrame { Type = AcceptFrameType.Accept, DeliveryId = delivery.DeliveryId }.ToJson(), token)
            .ConfigureAwait(false);
    }

    private async Task OnAcceptedAsync(AcceptedFrame frame, CancellationToken token)
    {
        Delivery? delivery;
        lock (gate)
        {
            awaitingAcceptance.Remove(frame.DeliveryId, out delivery);
        }

        if (delivery is null)
        {
            Fault(new InvalidDataException($"Tron accepted delivery {frame.DeliveryId}, which was never pushed"));
            return;
        }

        try
        {
            await store.SaveAsync(frame.DeliveryId, frame.Secret, token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Fault(ex);
            End(frame.DeliveryId);
            return;
        }

        Raise(DeliveryAccepted, frame.DeliveryId);
        var handler = handlers.Values.Single();
        _ = Task.Run(() => RunDeliveryAsync(delivery, handler), CancellationToken.None);
    }

    private async Task RunDeliveryAsync(Delivery delivery, RunnerHandler handler)
    {
        var token = handlerCts.Token;
        try
        {
            Outcome outcome;
            try
            {
                outcome = await handler(delivery, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                outcome = Outcome.Err($"handler failed: {ex.GetType().Name}: {ex.Message}");
            }

            try
            {
                Raise(ReportRecorded, await ReportAsync(delivery.DeliveryId, outcome, token).ConfigureAwait(false));
            }
            catch (ReportRejectedException ex)
            {
                Raise(ReportRejected, ex);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                Fault(ex);
            }
        }
        finally
        {
            End(delivery.DeliveryId);
        }
    }

    private async Task<ReportReceipt> ReportAsync(Guid deliveryId, Outcome outcome, CancellationToken token)
    {
        var secret = await store.LoadAsync(deliveryId, token).ConfigureAwait(false) ?? throw new MissingSecretException(deliveryId);
        var frame = new ReportFrame { Type = ReportFrameType.Report, DeliveryId = deliveryId, Secret = secret, Outcome = outcome.ToWire() }.ToJson();
        var waiter = new TaskCompletionSource<ReportReceipt>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (!reportWaiters.TryAdd(deliveryId, waiter))
            {
                throw new InvalidOperationException($"a report for delivery {deliveryId} is already in flight");
            }
        }

        try
        {
            using var cancellation = token.Register(() => waiter.TrySetCanceled(token));
            while (true)
            {
                var session = await WaitForSessionAsync(token).ConfigureAwait(false);
                try
                {
                    await session.SendAsync(frame, token).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException or IOException)
                {
                    await Task.WhenAny(session.Lost, Task.Delay(TimeSpan.FromMilliseconds(100), token)).ConfigureAwait(false);
                    continue;
                }

                // The answer can only come on the connection that carried the report; if it is lost first, send again on the next.
                if (await Task.WhenAny(waiter.Task, session.Lost).ConfigureAwait(false) == waiter.Task)
                {
                    break;
                }
            }

            var receipt = await waiter.Task.ConfigureAwait(false);
            await store.RemoveAsync(deliveryId, token).ConfigureAwait(false);
            return receipt;
        }
        finally
        {
            lock (gate)
            {
                reportWaiters.Remove(deliveryId);
            }
        }
    }

    private void CompleteReport(Guid deliveryId, Action<TaskCompletionSource<ReportReceipt>> complete)
    {
        TaskCompletionSource<ReportReceipt>? waiter;
        lock (gate)
        {
            reportWaiters.TryGetValue(deliveryId, out waiter);
        }

        if (waiter is not null)
        {
            complete(waiter);
        }
    }

    private void Publish(Session session)
    {
        lock (gate)
        {
            currentSession.TrySetResult(session);
        }
    }

    private void Retire(Session session)
    {
        lock (gate)
        {
            if (currentSession.Task.IsCompletedSuccessfully && currentSession.Task.Result == session)
            {
                currentSession = new TaskCompletionSource<Session>(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }

        session.MarkLost();
    }

    private async Task<Session> WaitForSessionAsync(CancellationToken token)
    {
        while (true)
        {
            Task<Session> current;
            lock (gate)
            {
                current = currentSession.Task;
            }

            var session = await current.WaitAsync(token).ConfigureAwait(false);
            if (!session.Lost.IsCompleted)
            {
                return session;
            }

            await Task.Yield();
        }
    }

    private bool Begin(Guid deliveryId)
    {
        lock (gate)
        {
            if (!unanswered.Add(deliveryId))
            {
                return false;
            }

            if (unanswered.Count == 1)
            {
                idle = NewSignal();
            }

            return true;
        }
    }

    private void End(Guid deliveryId)
    {
        TaskCompletionSource? drained = null;
        lock (gate)
        {
            if (unanswered.Remove(deliveryId) && unanswered.Count == 0)
            {
                drained = idle;
            }
        }

        drained?.TrySetResult();
    }

    private Task WaitIdle()
    {
        lock (gate)
        {
            return unanswered.Count == 0 ? Task.CompletedTask : idle.Task;
        }
    }

    private void Fault(Exception exception) => Raise(Faulted, exception);

    private static void Raise<T>(Action<T>? observers, T argument)
    {
        if (observers is null)
        {
            return;
        }

        foreach (var observer in observers.GetInvocationList().Cast<Action<T>>())
        {
            try
            {
                observer(argument);
            }
            catch
            {
                // An observer's failure must not take the connection down.
            }
        }
    }

    private sealed class Session
    {
        private readonly SemaphoreSlim sendLock = new(1, 1);
        private readonly TaskCompletionSource lost = NewSignal();

        public Session(ClientWebSocket socket) => Socket = socket;

        public ClientWebSocket Socket { get; }

        public Guid Id { get; set; }

        public Task Lost => lost.Task;

        public void MarkLost() => lost.TrySetResult();

        public async Task SendAsync(string json, CancellationToken token)
        {
            await sendLock.WaitAsync(token).ConfigureAwait(false);
            try
            {
                await Socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, endOfMessage: true, token).ConfigureAwait(false);
            }
            finally
            {
                sendLock.Release();
            }
        }
    }
}
