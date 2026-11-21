"""Decoding and encoding of runner-protocol frames, only through the generated bindings."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from .errors import MalformedFrameError
from .generated.protocol import (
    AcceptedFrame,
    AcceptFrame,
    AcceptFrameType,
    AcceptRefusedFrame,
    AnnouncedFrame,
    AnnounceFrame,
    AnnounceFrameType,
    AuthenticatedFrame,
    AuthenticateFrame,
    AuthenticateFrameType,
    AuthenticationFailedFrame,
    ProtocolErrorFrame,
    ReportFrame,
    ReportFrameType,
    ReportRecordedFrame,
    ReportRejectedFrame,
    RunnerAnnouncement,
    RunnerProtocolVersion,
    RunOutcome,
    ServerFrameKind,
    ServerFrameTag,
    WorkFrame,
    accept_refused_frame_from_dict,
    accepted_frame_from_dict,
    announced_frame_from_dict,
    authenticated_frame_from_dict,
    authentication_failed_frame_from_dict,
    protocol_error_frame_from_dict,
    report_recorded_frame_from_dict,
    report_rejected_frame_from_dict,
    work_frame_from_dict,
)
from .generated.protocol_version import PROTOCOL_VERSION
from .outcomes import Err, Ok, Outcome

ServerFrame = (
    AuthenticatedFrame
    | AnnouncedFrame
    | AuthenticationFailedFrame
    | WorkFrame
    | AcceptedFrame
    | AcceptRefusedFrame
    | ReportRecordedFrame
    | ReportRejectedFrame
    | ProtocolErrorFrame
)

_DECODERS: dict[ServerFrameKind, Callable[[Any], ServerFrame]] = {
    ServerFrameKind.AUTHENTICATED: authenticated_frame_from_dict,
    ServerFrameKind.ANNOUNCED: announced_frame_from_dict,
    ServerFrameKind.AUTHENTICATION_FAILED: authentication_failed_frame_from_dict,
    ServerFrameKind.WORK: work_frame_from_dict,
    ServerFrameKind.ACCEPTED: accepted_frame_from_dict,
    ServerFrameKind.ACCEPT_REFUSED: accept_refused_frame_from_dict,
    ServerFrameKind.REPORT_RECORDED: report_recorded_frame_from_dict,
    ServerFrameKind.REPORT_REJECTED: report_rejected_frame_from_dict,
    ServerFrameKind.PROTOCOL_ERROR: protocol_error_frame_from_dict,
}

# A frame added to the protocol regenerates `ServerFrameKind`; failing here makes that drift loud.
_UNHANDLED = set(ServerFrameKind) - set(_DECODERS)
if _UNHANDLED:
    raise RuntimeError(f"protocol {PROTOCOL_VERSION} has server frames this SDK does not decode: {sorted(k.value for k in _UNHANDLED)}")


def decode_server_frame(text: str) -> ServerFrame:
    try:
        document = json.loads(text)
        kind = ServerFrameTag.from_dict(document).type
        return _DECODERS[kind](document)
    except (ValueError, AssertionError, TypeError, KeyError) as error:
        raise MalformedFrameError(f"not a protocol {PROTOCOL_VERSION} server frame: {error}") from error


def authenticate_frame(token: str) -> str:
    return json.dumps(AuthenticateFrame(token=token, type=AuthenticateFrameType.AUTHENTICATE).to_dict())


def announce_frame(
    *,
    handler_keys: list[str],
    concurrency_capacity: int,
    display_name: str | None,
    runner_version: str | None,
    sdk_version: str,
) -> str:
    announcement = RunnerAnnouncement(
        concurrency_capacity=concurrency_capacity,
        handler_keys=handler_keys,
        display_name=display_name,
        protocol_version=RunnerProtocolVersion(PROTOCOL_VERSION),
        runner_version=runner_version,
        sdk_version=sdk_version,
    )
    return json.dumps(AnnounceFrame(announcement=announcement, type=AnnounceFrameType.ANNOUNCE).to_dict())


def accept_frame(delivery_id: Any) -> str:
    return json.dumps(AcceptFrame(delivery_id=delivery_id, type=AcceptFrameType.ACCEPT).to_dict())


def report_frame(delivery_id: Any, secret: str, outcome: Outcome) -> str:
    if isinstance(outcome, Ok):
        wire = RunOutcome(ok=outcome.message)
    elif isinstance(outcome, Err):
        wire = RunOutcome(err=outcome.message)
    else:
        raise TypeError(f"a handler outcome is Ok or Err, not {type(outcome).__name__}")
    return json.dumps(ReportFrame(delivery_id=delivery_id, outcome=wire, secret=secret, type=ReportFrameType.REPORT).to_dict())
