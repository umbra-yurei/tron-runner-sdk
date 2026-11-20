"""Typed errors. Every Tron refusal is a value of a generated closed enum, never parsed text."""

from __future__ import annotations

from uuid import UUID

from .generated.protocol import (
    AcceptRefusal,
    ConnectFailure,
    ProtocolViolation,
    ReportRejection,
)


class TronRunnerError(Exception):
    """Base class of every error this package raises or reports."""


class ConnectError(TronRunnerError):
    """The runner could not connect; `reason` is the generated `ConnectFailure`."""

    reason: ConnectFailure

    def __init__(self, reason: ConnectFailure, detail: str) -> None:
        super().__init__(f"{reason.value}: {detail}")
        self.reason = reason


class AuthenticationFailedError(ConnectError):
    """Tron did not accept the worker API key. Not retried."""

    def __init__(self) -> None:
        super().__init__(ConnectFailure.AUTHENTICATION_FAILED, "the worker API key was not accepted")


class AnnouncementRejectedError(ConnectError):
    """Tron refused the announcement (capacity, handler keys, names or versions). Not retried."""

    violation: ProtocolViolation

    def __init__(self, violation: ProtocolViolation) -> None:
        super().__init__(ConnectFailure.ANNOUNCEMENT_REJECTED, f"protocol_error {violation.value}")
        self.violation = violation


class UnreachableError(ConnectError):
    """The first connection attempt failed at the transport."""

    def __init__(self, detail: str) -> None:
        super().__init__(ConnectFailure.UNREACHABLE, detail)


class AcceptRefusedError(TronRunnerError):
    """Tron refused `accept` for a delivery; its handler was not run."""

    delivery_id: UUID
    reason: AcceptRefusal

    def __init__(self, delivery_id: UUID, reason: AcceptRefusal) -> None:
        super().__init__(f"accept of delivery {delivery_id} refused: {reason.value}")
        self.delivery_id = delivery_id
        self.reason = reason


class ReportRejectedError(TronRunnerError):
    """Tron rejected a report. It is not retried and the stored secret is kept."""

    delivery_id: UUID
    reason: ReportRejection

    def __init__(self, delivery_id: UUID, reason: ReportRejection) -> None:
        super().__init__(f"report of delivery {delivery_id} rejected: {reason.value}")
        self.delivery_id = delivery_id
        self.reason = reason


class ProtocolViolationError(TronRunnerError):
    """Tron answered `protocol_error` on an established connection."""

    violation: ProtocolViolation

    def __init__(self, violation: ProtocolViolation) -> None:
        super().__init__(f"protocol_error {violation.value}")
        self.violation = violation


class MalformedFrameError(TronRunnerError):
    """Tron sent something that is not a frame of the supported protocol version."""


class DeliveryLostError(TronRunnerError):
    """The connection ended after `accept` was sent and before Tron answered; the delivery is abandoned."""

    delivery_id: UUID

    def __init__(self, delivery_id: UUID) -> None:
        super().__init__(f"connection lost before Tron answered the accept of delivery {delivery_id}")
        self.delivery_id = delivery_id


class UnroutableDeliveryError(TronRunnerError):
    """A delivery arrived that cannot be routed to one handler, so it was not accepted.

    Protocol v1 `work` frames do not name the handler key they were dispatched for, so a runner
    with more than one registered handler cannot tell which to run.
    """

    delivery_id: UUID

    def __init__(self, delivery_id: UUID, handler_count: int) -> None:
        super().__init__(
            f"delivery {delivery_id} cannot be routed: protocol v1 `work` frames carry no handler key "
            f"and {handler_count} handlers are registered"
        )
        self.delivery_id = delivery_id


class SecretStoreError(TronRunnerError):
    """The secret store failed; the delivery's handler was not run."""

    delivery_id: UUID

    def __init__(self, delivery_id: UUID, cause: BaseException) -> None:
        super().__init__(f"secret store failed for delivery {delivery_id}: {cause}")
        self.delivery_id = delivery_id


class MissingSecretError(TronRunnerError):
    """No secret is stored for a delivery that was to be reported."""

    delivery_id: UUID

    def __init__(self, delivery_id: UUID) -> None:
        super().__init__(f"no stored secret for delivery {delivery_id}")
        self.delivery_id = delivery_id
