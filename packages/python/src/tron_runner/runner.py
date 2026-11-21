"""The runner: an authenticated, reconnecting connection to Tron that runs registered handlers."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any, Self
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from . import _frames
from ._version import __version__
from .errors import (
    AcceptRefusedError,
    AnnouncementRejectedError,
    AuthenticationFailedError,
    ConnectError,
    DeliveryLostError,
    MalformedFrameError,
    MissingSecretError,
    ProtocolViolationError,
    ReportRejectedError,
    RunnerCrashedError,
    SecretStoreError,
    TronRunnerError,
    UnreachableError,
    UnroutableDeliveryError,
)
from .generated.protocol import (
    AcceptedFrame,
    AcceptRefusedFrame,
    AnnouncedFrame,
    AuthenticatedFrame,
    AuthenticationFailedFrame,
    ProtocolErrorFrame,
    ReportRecordedFrame,
    ReportRejectedFrame,
    WorkFrame,
)
from .generated.protocol_version import RUNNER_CHANNEL_ADDRESS
from .outcomes import Delivery, Err, Handler, Ok, Outcome, RecordedReport
from .secret_store import SecretStore

logger = logging.getLogger("tron_runner")

BACKOFF_INITIAL_SECONDS = 0.1
BACKOFF_MAX_SECONDS = 5.0
_OPEN_TIMEOUT_SECONDS = 10.0
_WEBSOCKET_SCHEMES = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}


def runner_url(base_url: str) -> str:
    """The runner WebSocket URL for a Tron base URL; the channel path comes from the generated protocol."""
    parts = urlsplit(base_url)
    scheme = _WEBSOCKET_SCHEMES.get(parts.scheme)
    if scheme is None or not parts.netloc:
        raise ValueError(f"not a Tron base URL (expected http, https, ws or wss with a host): {base_url!r}")
    return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + RUNNER_CHANNEL_ADDRESS, "", ""))


class _Session:
    """One authenticated connection."""

    def __init__(self, websocket: ClientConnection) -> None:
        self.websocket = websocket
        self.session_id: UUID | None = None
        self.announced = False
        self.lost = asyncio.Event()
        self.pending_accepts: dict[UUID, asyncio.Future[AcceptedFrame]] = {}


class Runner:
    """Connects to Tron, announces its handlers, and runs the work Tron pushes.

    Register handlers, then ``await runner.start()`` (or use ``async with``). ``start`` raises a typed
    `ConnectError` when the first connection fails; after that, a lost connection is re-established
    automatically with exponential backoff and a fresh authenticate and announce. ``await runner.stop()``
    stops taking work, waits for in-flight handlers and their reports to be answered, then disconnects.

    Refusals Tron raises while the runner works in the background (`AcceptRefusedError`,
    `ReportRejectedError`, `ProtocolViolationError`, ...) are passed to ``on_error``, or logged.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        secret_store: SecretStore,
        concurrency_capacity: int = 1,
        display_name: str | None = None,
        runner_version: str | None = None,
        on_connected: Callable[[UUID], None] | None = None,
        on_delivery_accepted: Callable[[Delivery], None] | None = None,
        on_report_recorded: Callable[[RecordedReport], None] | None = None,
        on_error: Callable[[TronRunnerError], None] | None = None,
    ) -> None:
        self._url = runner_url(base_url)
        self._token = token
        self._store = secret_store
        self._capacity = concurrency_capacity
        self._display_name = display_name
        self._runner_version = runner_version
        self._on_connected = on_connected
        self._on_delivery_accepted = on_delivery_accepted
        self._on_report_recorded = on_report_recorded
        self._on_error = on_error

        self._handlers: dict[str, Handler] = {}
        self._session: _Session | None = None
        self._ever_connected = False
        self._stopping = False
        self._fatal: TronRunnerError | None = None
        self._supervisor: asyncio.Task[None] | None = None
        self._first: asyncio.Future[None] | None = None
        # Deliveries from `work` (or a report of an earlier process) until Tron's final answer.
        self._inflight: set[UUID] = set()
        self._answers: dict[UUID, asyncio.Future[RecordedReport]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._changed = asyncio.Event()

    def register(self, handler_key: str, handler: Handler) -> None:
        """Register `handler` for `handler_key`; the set of keys is what is announced."""
        if self._supervisor is not None:
            raise RuntimeError("handlers must be registered before the runner starts: the announcement is fixed per connection")
        if handler_key in self._handlers:
            raise ValueError(f"a handler is already registered for {handler_key!r}")
        self._handlers[handler_key] = handler

    def handler(self, handler_key: str) -> Callable[[Handler], Handler]:
        """Decorator form of `register`."""

        def decorate(function: Handler) -> Handler:
            self.register(handler_key, function)
            return function

        return decorate

    async def start(self) -> None:
        """Connect, authenticate and announce. Raises a `ConnectError` if the first attempt fails."""
        if self._supervisor is not None:
            raise RuntimeError("the runner was already started")
        self._first = asyncio.get_running_loop().create_future()
        self._supervisor = asyncio.create_task(self._supervise(self._first))
        await self._first

    async def wait_closed(self) -> None:
        """Wait until the runner has stopped; raises the `ConnectError` or `RunnerCrashedError` that ended it, if one did."""
        if self._supervisor is None:
            raise RuntimeError("the runner was not started")
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.shield(self._supervisor)
        if self._fatal is not None:
            raise self._fatal

    async def run(self) -> None:
        """Start, then serve until stopped or until the key is rejected."""
        await self.start()
        await self.wait_closed()

    async def stop(self) -> None:
        """Take no new work, finish in-flight handlers and their reports, then disconnect."""
        if self._supervisor is None:
            return
        self._stopping = True
        self._pulse()
        while self._inflight:
            await self._changed.wait()
        self._supervisor.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._supervisor
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.stop()

    async def pending(self) -> list[UUID]:
        """Deliveries a secret is stored for: accepted, by this or an earlier process, and not yet reported."""
        return await self._store.pending()

    async def report_pending(self, delivery_id: UUID, outcome: Outcome) -> RecordedReport:
        """Report an accepted delivery from the stored secret, e.g. after a restart.

        Raises `ReportRejectedError` if Tron rejects it and `MissingSecretError` if no secret is stored.
        """
        if self._supervisor is None:
            raise RuntimeError("the runner was not started")
        self._begin(delivery_id)
        try:
            return await self._report(delivery_id, outcome)
        finally:
            self._finish(delivery_id)

    # -- connection ---------------------------------------------------------------------------

    async def _supervise(self, first: asyncio.Future[None]) -> None:
        backoff = BACKOFF_INITIAL_SECONDS
        while True:
            try:
                reached_announced = await self._connection(first)
            except ConnectError as error:
                self._fail(first, error)
                return
            except Exception as error:
                self._fail(first, RunnerCrashedError(error))
                return
            if reached_announced:
                backoff = BACKOFF_INITIAL_SECONDS
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX_SECONDS)

    def _fail(self, first: asyncio.Future[None], error: TronRunnerError) -> None:
        if first.done():
            self._fatal = error
            self._emit_error(error)
        else:
            first.set_exception(error)
        self._pulse()

    async def _connection(self, first: asyncio.Future[None]) -> bool:
        """One connection from handshake to loss. Returns whether the announcement was acknowledged."""
        session: _Session | None = None
        try:
            async with connect(self._url, open_timeout=_OPEN_TIMEOUT_SECONDS) as websocket:
                session = _Session(websocket)
                await websocket.send(_frames.authenticate_frame(self._token))
                async for message in websocket:
                    if not isinstance(message, str):
                        raise MalformedFrameError("Tron sent a binary frame")
                    self._on_frame(session, _frames.decode_server_frame(message), first)
        except MalformedFrameError as error:
            self._emit_error(error)
        except (OSError, WebSocketException, TimeoutError) as error:
            if not self._ever_connected and not (session is not None and session.announced):
                raise UnreachableError(f"{type(error).__name__}: {error}") from error
        finally:
            if session is not None:
                self._lose(session)
        if not self._ever_connected:
            raise UnreachableError("the connection ended before Tron acknowledged the announcement")
        return session is not None and session.announced

    def _lose(self, session: _Session) -> None:
        session.lost.set()
        if self._session is session:
            self._session = None
        for delivery_id, accepted in session.pending_accepts.items():
            if not accepted.done():
                accepted.set_exception(DeliveryLostError(delivery_id))
        session.pending_accepts.clear()
        self._pulse()

    def _on_frame(self, session: _Session, frame: _frames.ServerFrame, first: asyncio.Future[None]) -> None:
        match frame:
            case AuthenticatedFrame():
                session.session_id = frame.session_id
                self._send_background(
                    session,
                    _frames.announce_frame(
                        handler_keys=list(self._handlers),
                        concurrency_capacity=self._capacity,
                        display_name=self._display_name,
                        runner_version=self._runner_version,
                        sdk_version=__version__,
                    ),
                )
            case AnnouncedFrame():
                session.announced = True
                self._ever_connected = True
                self._session = session
                if not first.done():
                    first.set_result(None)
                if session.session_id is not None:
                    self._notify(self._on_connected, session.session_id)
                self._pulse()
            case AuthenticationFailedFrame():
                raise AuthenticationFailedError()
            case ProtocolErrorFrame():
                if not session.announced:
                    raise AnnouncementRejectedError(frame.reason)
                self._emit_error(ProtocolViolationError(frame.reason))
            case WorkFrame():
                self._on_work(session, frame)
            case AcceptedFrame():
                self._resolve_accept(session, frame.delivery_id, accepted=frame)
            case AcceptRefusedFrame():
                self._resolve_accept(session, frame.delivery_id, refusal=AcceptRefusedError(frame.delivery_id, frame.reason))
            case ReportRecordedFrame():
                self._resolve_answer(frame.delivery_id, recorded=RecordedReport(frame.delivery_id, frame.late))
            case ReportRejectedFrame():
                self._resolve_answer(frame.delivery_id, rejection=ReportRejectedError(frame.delivery_id, frame.reason))

    def _send_background(self, session: _Session, payload: str) -> None:
        task = asyncio.create_task(self._send(session, payload))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, session: _Session, payload: str) -> None:
        with contextlib.suppress(ConnectionClosed):
            await session.websocket.send(payload)

    # -- deliveries ---------------------------------------------------------------------------

    def _on_work(self, session: _Session, frame: WorkFrame) -> None:
        if self._stopping:
            return
        if len(self._handlers) != 1:
            self._emit_error(UnroutableDeliveryError(frame.delivery_id, len(self._handlers)))
            return
        handler = next(iter(self._handlers.values()))
        delivery = Delivery(
            delivery_id=frame.delivery_id,
            run_id=frame.run_id,
            job_id=frame.job_id,
            job_name=frame.job_name,
            scheduled_for=_timestamp(frame.scheduled_for),
            accept_deadline=_timestamp(frame.accept_deadline),
        )
        accepted: asyncio.Future[AcceptedFrame] = asyncio.get_running_loop().create_future()
        session.pending_accepts[delivery.delivery_id] = accepted
        self._begin(delivery.delivery_id)
        self._send_background(session, _frames.accept_frame(delivery.delivery_id))
        task = asyncio.create_task(self._process(delivery, handler, accepted))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _resolve_accept(
        self,
        session: _Session,
        delivery_id: UUID,
        *,
        accepted: AcceptedFrame | None = None,
        refusal: AcceptRefusedError | None = None,
    ) -> None:
        future = session.pending_accepts.pop(delivery_id, None)
        if future is None or future.done():
            self._emit_error(MalformedFrameError(f"Tron answered an accept that was never sent: {delivery_id}"))
        elif refusal is not None:
            future.set_exception(refusal)
        elif accepted is not None:
            future.set_result(accepted)

    def _resolve_answer(
        self,
        delivery_id: UUID,
        *,
        recorded: RecordedReport | None = None,
        rejection: ReportRejectedError | None = None,
    ) -> None:
        future = self._answers.get(delivery_id)
        if future is None or future.done():
            self._emit_error(MalformedFrameError(f"Tron answered a report that was never sent: {delivery_id}"))
        elif rejection is not None:
            future.set_exception(rejection)
        elif recorded is not None:
            future.set_result(recorded)

    async def _process(self, delivery: Delivery, handler: Handler, accepted: asyncio.Future[AcceptedFrame]) -> None:
        try:
            try:
                frame = await accepted
            except (AcceptRefusedError, DeliveryLostError) as error:
                self._emit_error(error)
                return
            try:
                await self._store.save(delivery.delivery_id, frame.secret)
            except Exception as error:
                self._emit_error(SecretStoreError(delivery.delivery_id, error))
                return
            self._notify(self._on_delivery_accepted, delivery)
            outcome = await _run_handler(handler, delivery)
            try:
                await self._report(delivery.delivery_id, outcome)
            except (ReportRejectedError, MissingSecretError, ConnectError) as error:
                self._emit_error(error)
        finally:
            self._finish(delivery.delivery_id)

    async def _report(self, delivery_id: UUID, outcome: Outcome) -> RecordedReport:
        """Send the report on the current connection, and on the next ones until Tron answers it."""
        secret = await self._store.load(delivery_id)
        if secret is None:
            raise MissingSecretError(delivery_id)
        payload = _frames.report_frame(delivery_id, secret, outcome)
        loop = asyncio.get_running_loop()
        try:
            while True:
                session = await self._announced_session()
                answer: asyncio.Future[RecordedReport] = loop.create_future()
                self._answers[delivery_id] = answer
                try:
                    await session.websocket.send(payload)
                except ConnectionClosed:
                    await session.lost.wait()
                    continue
                lost: asyncio.Future[Any] = asyncio.ensure_future(session.lost.wait())
                waiting: set[asyncio.Future[Any]] = {answer, lost}
                try:
                    await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    lost.cancel()
                if answer.done():
                    recorded = answer.result()
                    break
        finally:
            self._answers.pop(delivery_id, None)
        await self._store.remove(delivery_id)
        self._notify(self._on_report_recorded, recorded)
        return recorded

    async def _announced_session(self) -> _Session:
        while True:
            if self._fatal is not None:
                raise self._fatal
            if self._session is not None:
                return self._session
            await self._changed.wait()

    def _begin(self, delivery_id: UUID) -> None:
        self._inflight.add(delivery_id)

    def _finish(self, delivery_id: UUID) -> None:
        self._inflight.discard(delivery_id)
        self._pulse()

    def _pulse(self) -> None:
        self._changed.set()
        self._changed.clear()

    # -- callbacks ----------------------------------------------------------------------------

    def _emit_error(self, error: TronRunnerError) -> None:
        if self._on_error is None:
            logger.error("%s", error)
        else:
            self._notify(self._on_error, error)

    @staticmethod
    def _notify(callback: Callable[[Any], None] | None, argument: Any) -> None:
        if callback is None:
            return
        try:
            callback(argument)
        except Exception:
            logger.exception("a runner callback raised")


async def _run_handler(handler: Handler, delivery: Delivery) -> Outcome:
    try:
        outcome = await handler(delivery)
    except Exception as error:
        logger.exception("handler for delivery %s raised", delivery.delivery_id)
        return Err(f"{type(error).__name__}: {error}")
    if isinstance(outcome, (Ok, Err)):
        return outcome
    return Err(f"handler returned {type(outcome).__name__}, not Ok or Err")


def _timestamp(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError as error:
        raise MalformedFrameError(f"not an RFC 3339 timestamp: {value!r}") from error
