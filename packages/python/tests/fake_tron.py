"""A scripted stand-in for Tron's runner channel, speaking only through the generated frame bindings."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

from websockets.asyncio.server import ServerConnection, serve

from tron_runner.generated import protocol


RunnerFrame = protocol.AuthenticateFrame | protocol.AnnounceFrame | protocol.AcceptFrame | protocol.ReportFrame

_RUNNER_DECODERS: dict[protocol.RunnerFrameKind, Callable[[Any], RunnerFrame]] = {
    protocol.RunnerFrameKind.AUTHENTICATE: protocol.authenticate_frame_from_dict,
    protocol.RunnerFrameKind.ANNOUNCE: protocol.announce_frame_from_dict,
    protocol.RunnerFrameKind.ACCEPT: protocol.accept_frame_from_dict,
    protocol.RunnerFrameKind.REPORT: protocol.report_frame_from_dict,
}
assert set(_RUNNER_DECODERS) == set(protocol.RunnerFrameKind)


def decode_runner_frame(text: str | bytes) -> RunnerFrame:
    document = json.loads(text)
    return _RUNNER_DECODERS[protocol.RunnerFrameTag.from_dict(document).type](document)


def frame(document: Any) -> str:
    return json.dumps(document.to_dict())


def work(delivery_id: UUID, *, scheduled_for: str = "2030-01-01T00:00:00Z", handler_key: str = "backup") -> str:
    return frame(
        protocol.WorkFrame(
            accept_deadline="2030-01-01T00:00:30.123456789Z",
            delivery_id=delivery_id,
            handler_key="backup",
            handler_key=handler_key,
            job_id=uuid4(),
            job_name="nightly",
            run_id=uuid4(),
            scheduled_for=scheduled_for,
            type=protocol.WorkFrameType.WORK,
        )
    )


class FakeTron:
    """Accepts connections, answers authenticate and announce, and records the runner's frames.

    `on_announced(connection, number)` runs after each announcement; `on_frame` handles the
    accept and report frames, already decoded through the generated bindings.
    """

    def __init__(self, *, accept_token: str = "good") -> None:
        self.accept_token = accept_token
        self.connections = 0
        self.announcements: list[protocol.RunnerAnnouncement] = []
        self.received: list[RunnerFrame] = []
        self.on_announced: Callable[[ServerConnection, int], Awaitable[None]] | None = None
        self.on_frame: Callable[[ServerConnection, RunnerFrame], Awaitable[None]] | None = None
        self.port = 0
        self._server: Any = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def __aenter__(self) -> FakeTron:
        self._server = await serve(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, connection: ServerConnection) -> None:
        self.connections += 1
        number = self.connections
        authenticate = protocol.authenticate_frame_from_dict(json.loads(await connection.recv()))
        if authenticate.token != self.accept_token:
            await connection.send(frame(protocol.AuthenticationFailedFrame(type=protocol.AuthenticationFailedFrameType.AUTHENTICATION_FAILED)))
            await connection.close()
            return
        await connection.send(
            frame(
                protocol.AuthenticatedFrame(
                    session_id=uuid4(), type=protocol.AuthenticatedFrameType.AUTHENTICATED, worker_api_key_id=uuid4()
                )
            )
        )
        async for message in connection:
            runner_frame = decode_runner_frame(message)
            self.received.append(runner_frame)
            if isinstance(runner_frame, protocol.AnnounceFrame):
                self.announcements.append(runner_frame.announcement)
                await connection.send(frame(protocol.AnnouncedFrame(type=protocol.AnnouncedFrameType.ANNOUNCED)))
                if self.on_announced is not None:
                    await self.on_announced(connection, number)
            elif self.on_frame is not None:
                await self.on_frame(connection, runner_frame)


def accepted(delivery_id: UUID, secret: str) -> str:
    return frame(protocol.AcceptedFrame(delivery_id=delivery_id, secret=secret, type=protocol.AcceptedFrameType.ACCEPTED))


def accept_refused(delivery_id: UUID, reason: protocol.AcceptRefusal) -> str:
    return frame(protocol.AcceptRefusedFrame(delivery_id=delivery_id, reason=reason, type=protocol.AcceptRefusedEventType.ACCEPT_REFUSED))


def report_recorded(delivery_id: UUID, late: bool = False) -> str:
    return frame(protocol.ReportRecordedFrame(delivery_id=delivery_id, late=late, type=protocol.ReportRecordedEventType.REPORT_RECORDED))


def report_rejected(delivery_id: UUID, reason: protocol.ReportRejection) -> str:
    return frame(protocol.ReportRejectedFrame(delivery_id=delivery_id, reason=reason, type=protocol.ReportRejectedEventType.REPORT_REJECTED))
