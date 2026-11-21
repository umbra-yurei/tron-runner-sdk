"""The Python SDK's conformance adapter: exposes `tron_runner` to the shared suite over JSON lines on stdio.

Commands and events are decoded and encoded only with the generated bindings in
`tron_runner.generated.protocol`; there is no hand-written shape here.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages" / "python" / "src"))

from tron_runner import (  # noqa: E402
    PROTOCOL_VERSION,
    RUNNER_CHANNEL_ADDRESS,
    AcceptRefusedError,
    ConnectError,
    Delivery,
    Err,
    FileSecretStore,
    Handler,
    Ok,
    Outcome,
    RecordedReport,
    ReportRejectedError,
    Runner,
    TronRunnerError,
    __version__,
)
from tron_runner.generated import protocol  # noqa: E402

COMMAND_DECODERS = {
    protocol.AdapterCommandKind.START: protocol.start_command_from_dict,
    protocol.AdapterCommandKind.REPORT_PENDING: protocol.report_pending_command_from_dict,
    protocol.AdapterCommandKind.LIST_PENDING: protocol.list_pending_command_from_dict,
    protocol.AdapterCommandKind.STOP: protocol.stop_command_from_dict,
}
assert set(COMMAND_DECODERS) == set(protocol.AdapterCommandKind), "an adapter command is not decoded"


class Event(Protocol):
    def to_dict(self) -> dict[str, Any]: ...


def emit(event: Event) -> None:
    sys.stdout.write(json.dumps(event.to_dict()) + "\n")
    sys.stdout.flush()


def fail(message: str) -> None:
    emit(protocol.AdapterErrorEvent(message=message, type=protocol.AdapterErrorEventType.ERROR))


class WrappedStore(FileSecretStore):
    """The pluggable-store interface, exercised through the two wrappers the suite asks for."""

    def __init__(self, directory: str, kind: protocol.SecretStoreKind) -> None:
        super().__init__(directory)
        self._kind = kind

    async def load(self, delivery_id: UUID) -> str | None:
        secret = await super().load(delivery_id)
        if self._kind == protocol.SecretStoreKind.TAMPERED and secret is not None:
            return secret + "-tampered"
        return secret

    async def remove(self, delivery_id: UUID) -> None:
        if self._kind != protocol.SecretStoreKind.RETAINING:
            await super().remove(delivery_id)


def base_url(runner_url: str) -> str:
    """The SDK takes Tron's base URL and appends the channel path; the harness passes the full channel URL."""
    parts = urlsplit(runner_url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path.removesuffix(RUNNER_CHANNEL_ADDRESS), "", ""))


def outcome_of(wire: protocol.RunOutcome) -> Outcome:
    if wire.ok is not None:
        return Ok(wire.ok)
    assert wire.err is not None
    return Err(wire.err)


def on_error(error: TronRunnerError) -> None:
    if isinstance(error, AcceptRefusedError):
        emit(
            protocol.AcceptRefusedEvent(
                delivery_id=error.delivery_id, reason=error.reason, type=protocol.AcceptRefusedEventType.ACCEPT_REFUSED
            )
        )
    elif isinstance(error, ReportRejectedError):
        emit(
            protocol.ReportRejectedEvent(
                delivery_id=error.delivery_id, reason=error.reason, type=protocol.ReportRejectedEventType.REPORT_REJECTED
            )
        )
    else:
        fail(str(error))


def on_connected(session_id: UUID) -> None:
    emit(protocol.ConnectedEvent(session_id=session_id, type=protocol.ConnectedEventType.CONNECTED))


def on_delivery_accepted(delivery: Delivery) -> None:
    emit(protocol.DeliveryAcceptedEvent(delivery_id=delivery.delivery_id, type=protocol.DeliveryAcceptedEventType.DELIVERY_ACCEPTED))


def on_report_recorded(recorded: RecordedReport) -> None:
    emit(
        protocol.ReportRecordedEvent(
            delivery_id=recorded.delivery_id, late=recorded.late, type=protocol.ReportRecordedEventType.REPORT_RECORDED
        )
    )


def scripted(script: protocol.HandlerScript) -> Handler:
    async def handle(delivery: Delivery) -> Outcome:
        emit(
            protocol.HandlerInvokedEvent(
                handler_key=script.handler_key,
                delivery_id=delivery.delivery_id,
                run_id=delivery.run_id,
                job_id=delivery.job_id,
                job_name=delivery.job_name,
                type=protocol.HandlerInvokedEventType.HANDLER_INVOKED,
            )
        )
        await asyncio.sleep(script.delay_ms / 1000)
        if script.outcome == protocol.HandlerOutcomeKind.REPLY_OK:
            return Ok(script.message)
        return Err(script.message)

    return handle


async def stdin_lines() -> "asyncio.Queue[str | None]":
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def pump() -> None:
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, pump)
    return queue


async def main() -> None:
    emit(
        protocol.ReadyEvent(
            protocol_version=protocol.RunnerProtocolVersion(PROTOCOL_VERSION),
            sdk_version=__version__,
            type=protocol.ReadyEventType.READY,
        )
    )
    lines = await stdin_lines()
    runner: Runner | None = None
    while (line := await lines.get()) is not None:
        if not line.strip():
            continue
        try:
            document = json.loads(line)
            command = COMMAND_DECODERS[protocol.AdapterCommandTag.from_dict(document).type](document)
            if isinstance(command, protocol.StartCommand):
                runner = Runner(
                    base_url(command.tron_url),
                    command.token,
                    secret_store=WrappedStore(command.secret_store.directory, command.secret_store.kind),
                    concurrency_capacity=command.concurrency_capacity,
                    display_name=command.display_name,
                    runner_version=command.runner_version,
                    on_connected=on_connected,
                    on_delivery_accepted=on_delivery_accepted,
                    on_report_recorded=on_report_recorded,
                    on_error=on_error,
                )
                for script in command.handlers:
                    runner.register(script.handler_key, scripted(script))
                try:
                    await runner.start()
                except ConnectError as error:
                    emit(
                        protocol.ConnectFailedEvent(reason=error.reason, type=protocol.ConnectFailedEventType.CONNECT_FAILED)
                    )
            elif isinstance(command, protocol.ReportPendingCommand):
                await require(runner).report_pending(command.delivery_id, outcome_of(command.outcome))
            elif isinstance(command, protocol.ListPendingCommand):
                emit(protocol.PendingEvent(delivery_ids=await require(runner).pending(), type=protocol.PendingEventType.PENDING))
            elif isinstance(command, protocol.StopCommand):
                await require(runner).stop()
                emit(protocol.StoppedEvent(type=protocol.StoppedEventType.STOPPED))
                # The stdin reader thread blocks until the harness closes the pipe; do not wait for it.
                os._exit(0)
        except ReportRejectedError as error:
            on_error(error)
        except Exception as error:
            fail(f"{type(error).__name__}: {error}")


def require(runner: Runner | None) -> Runner:
    if runner is None:
        raise RuntimeError("no start command was received")
    return runner


asyncio.run(main())
