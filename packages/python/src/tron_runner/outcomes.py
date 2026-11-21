"""What a handler receives and returns."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID


@dataclass(frozen=True)
class Delivery:
    """One run Tron pushed to this runner."""

    delivery_id: UUID
    run_id: UUID
    job_id: UUID
    job_name: str
    scheduled_for: datetime
    accept_deadline: datetime


@dataclass(frozen=True)
class Ok:
    """The handler succeeded; `message` is recorded as the run's result."""

    message: str


@dataclass(frozen=True)
class Err:
    """The handler failed; `message` is recorded as the run's result."""

    message: str


Outcome = Ok | Err
Handler = Callable[[Delivery], Awaitable[Outcome]]


@dataclass(frozen=True)
class RecordedReport:
    """Tron recorded a report. `late` is true when it arrived past the job's lateness threshold."""

    delivery_id: UUID
    late: bool
