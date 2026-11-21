"""Python SDK for running Tron jobs on your own machines.

    runner = Runner("https://tron.example.com", token, secret_store=FileSecretStore("secrets"))

    @runner.handler("send-report")
    async def send_report(delivery: Delivery) -> Outcome:
        return Ok("sent")

    await runner.run()

Protocol messages are generated from Tron's published AsyncAPI document (`tron_runner.generated`);
`PROTOCOL_VERSION` is the runner protocol version this package speaks.
"""

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
    UnknownHandlerError,
)
from .generated.protocol_version import PROTOCOL_DOCUMENT_VERSION, PROTOCOL_VERSION, RUNNER_CHANNEL_ADDRESS
from .outcomes import Delivery, Err, Handler, Ok, Outcome, RecordedReport
from .runner import Runner, runner_url
from .secret_store import FileSecretStore, SecretStore

__all__ = [
    "PROTOCOL_DOCUMENT_VERSION",
    "PROTOCOL_VERSION",
    "RUNNER_CHANNEL_ADDRESS",
    "AcceptRefusedError",
    "AnnouncementRejectedError",
    "AuthenticationFailedError",
    "ConnectError",
    "Delivery",
    "DeliveryLostError",
    "Err",
    "FileSecretStore",
    "Handler",
    "MalformedFrameError",
    "MissingSecretError",
    "Ok",
    "Outcome",
    "ProtocolViolationError",
    "RecordedReport",
    "ReportRejectedError",
    "Runner",
    "RunnerCrashedError",
    "SecretStore",
    "SecretStoreError",
    "TronRunnerError",
    "UnreachableError",
    "UnknownHandlerError",
    "__version__",
    "runner_url",
]
