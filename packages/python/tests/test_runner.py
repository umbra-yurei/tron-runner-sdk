from __future__ import annotations

import asyncio
import stat
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar
from uuid import UUID, uuid4

import pytest
from websockets.asyncio.server import ServerConnection

import tron_runner
from tron_runner import (
    AcceptRefusedError,
    AuthenticationFailedError,
    ConnectError,
    Delivery,
    Err,
    FileSecretStore,
    Ok,
    Outcome,
    RecordedReport,
    MalformedFrameError,
    ReportRejectedError,
    Runner,
    RunnerCrashedError,
    TronRunnerError,
    UnreachableError,
    UnroutableDeliveryError,
)
from tron_runner.generated import protocol

from .fake_tron import FakeTron, RunnerFrame, accept_refused, accepted, report_recorded, report_rejected, work

T = TypeVar("T")
SECRET = "delivery-secret"


def run(scenario: Callable[[], Awaitable[T]]) -> T:
    async def bounded() -> T:
        return await asyncio.wait_for(scenario(), timeout=20)

    return asyncio.run(bounded())


def reports(tron: FakeTron) -> list[protocol.ReportFrame]:
    return [received for received in tron.received if isinstance(received, protocol.ReportFrame)]


def accepts(tron: FakeTron) -> list[protocol.AcceptFrame]:
    return [received for received in tron.received if isinstance(received, protocol.AcceptFrame)]


def serve_one_delivery(tron: FakeTron, delivery_id: UUID, *, answer: Callable[[UUID], str] = report_recorded) -> None:
    async def on_announced(connection: ServerConnection, number: int) -> None:
        if number == 1:
            await connection.send(work(delivery_id))

    async def on_frame(connection: ServerConnection, received: RunnerFrame) -> None:
        if isinstance(received, protocol.AcceptFrame):
            await connection.send(accepted(delivery_id, SECRET))
        elif isinstance(received, protocol.ReportFrame):
            await connection.send(answer(delivery_id))

    tron.on_announced = on_announced
    tron.on_frame = on_frame


async def handler_ok(delivery: Delivery) -> Outcome:
    return Ok(f"done {delivery.job_name}")


def test_runner_url_appends_the_generated_channel_to_the_base_url() -> None:
    assert tron_runner.runner_url("https://tron.example.com") == f"wss://tron.example.com{tron_runner.RUNNER_CHANNEL_ADDRESS}"
    assert tron_runner.runner_url("http://127.0.0.1:8090/") == f"ws://127.0.0.1:8090{tron_runner.RUNNER_CHANNEL_ADDRESS}"
    assert tron_runner.runner_url("https://example.com/tron") == f"wss://example.com/tron{tron_runner.RUNNER_CHANNEL_ADDRESS}"
    with pytest.raises(ValueError):
        tron_runner.runner_url("ftp://example.com")


def test_bad_token_is_a_typed_error_and_is_not_retried(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with FakeTron() as tron:
            runner = Runner(tron.url, "bad", secret_store=FileSecretStore(tmp_path))
            runner.register("h", handler_ok)
            with pytest.raises(AuthenticationFailedError) as raised:
                await runner.start()
            assert raised.value.reason is protocol.ConnectFailure.AUTHENTICATION_FAILED
            await asyncio.sleep(0.5)
            assert tron.connections == 1

    run(scenario)


def test_unreachable_tron_is_a_typed_error(tmp_path: Path) -> None:
    async def scenario() -> None:
        runner = Runner("http://127.0.0.1:1", "t", secret_store=FileSecretStore(tmp_path))
        runner.register("h", handler_ok)
        with pytest.raises(UnreachableError) as raised:
            await runner.start()
        assert isinstance(raised.value, ConnectError)
        assert raised.value.reason is protocol.ConnectFailure.UNREACHABLE

    run(scenario)


def test_announces_accepts_persists_before_running_and_reports_ok(tmp_path: Path) -> None:
    async def scenario() -> None:
        delivery_id = uuid4()
        async with FakeTron() as tron:
            serve_one_delivery(tron, delivery_id)
            store = FileSecretStore(tmp_path)
            stored_when_run: list[str | None] = []
            recorded: list[RecordedReport] = []
            done = asyncio.Event()

            async def handler(delivery: Delivery) -> Outcome:
                stored_when_run.append(await store.load(delivery.delivery_id))
                assert delivery.job_name == "nightly"
                assert delivery.accept_deadline.year == 2030
                return Ok("all good")

            def on_recorded(report: RecordedReport) -> None:
                recorded.append(report)
                done.set()

            runner = Runner(
                tron.url,
                "good",
                secret_store=store,
                concurrency_capacity=3,
                display_name="box",
                runner_version="9.9",
                on_report_recorded=on_recorded,
            )
            runner.register("send-report", handler)
            async with runner:
                await done.wait()
            announcement = tron.announcements[0]
            assert announcement.handler_keys == ["send-report"]
            assert announcement.concurrency_capacity == 3
            assert announcement.display_name == "box"
            assert announcement.runner_version == "9.9"
            assert announcement.sdk_version == tron_runner.__version__
            assert announcement.protocol_version is protocol.RunnerProtocolVersion(tron_runner.PROTOCOL_VERSION)
            assert stored_when_run == [SECRET]
            [report] = reports(tron)
            assert report.delivery_id == delivery_id
            assert report.secret == SECRET
            assert report.outcome == protocol.RunOutcome(ok="all good")
            assert recorded == [RecordedReport(delivery_id, False)]
            assert await store.pending() == []

    run(scenario)


def test_handler_exception_is_reported_as_err(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with FakeTron() as tron:
            serve_one_delivery(tron, uuid4())
            done = asyncio.Event()

            async def handler(delivery: Delivery) -> Outcome:
                raise RuntimeError("boom")

            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_report_recorded=lambda _: done.set())
            runner.register("h", handler)
            async with runner:
                await done.wait()
            assert reports(tron)[0].outcome == protocol.RunOutcome(err="RuntimeError: boom")

    run(scenario)


def test_refused_accept_is_typed_and_the_handler_is_not_run(tmp_path: Path) -> None:
    async def scenario() -> None:
        delivery_id = uuid4()
        async with FakeTron() as tron:

            async def on_announced(connection: ServerConnection, number: int) -> None:
                await connection.send(work(delivery_id))

            async def on_frame(connection: ServerConnection, received: RunnerFrame) -> None:
                if isinstance(received, protocol.AcceptFrame):
                    await connection.send(accept_refused(delivery_id, protocol.AcceptRefusal.DELIVERY_TIMED_OUT))

            tron.on_announced, tron.on_frame = on_announced, on_frame
            errors: list[TronRunnerError] = []
            invoked: list[Delivery] = []

            async def handler(delivery: Delivery) -> Outcome:
                invoked.append(delivery)
                return Ok("x")

            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_error=errors.append)
            runner.register("h", handler)
            async with runner:
                while not errors:
                    await asyncio.sleep(0.01)
            [error] = errors
            assert isinstance(error, AcceptRefusedError)
            assert error.reason is protocol.AcceptRefusal.DELIVERY_TIMED_OUT
            assert error.delivery_id == delivery_id
            assert invoked == []
            assert await FileSecretStore(tmp_path).pending() == []

    run(scenario)


def test_rejected_report_is_typed_and_keeps_the_secret(tmp_path: Path) -> None:
    async def scenario() -> None:
        delivery_id = uuid4()
        async with FakeTron() as tron:
            serve_one_delivery(tron, delivery_id, answer=lambda id: report_rejected(id, protocol.ReportRejection.WRONG_SECRET))
            errors: list[TronRunnerError] = []
            store = FileSecretStore(tmp_path)
            runner = Runner(tron.url, "good", secret_store=store, on_error=errors.append)
            runner.register("h", handler_ok)
            async with runner:
                while not errors:
                    await asyncio.sleep(0.01)
            [error] = errors
            assert isinstance(error, ReportRejectedError)
            assert error.reason is protocol.ReportRejection.WRONG_SECRET
            assert len(reports(tron)) == 1
            assert await store.pending() == [delivery_id]

    run(scenario)


def test_reconnects_with_a_fresh_announcement_after_the_connection_drops(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with FakeTron() as tron:

            async def on_announced(connection: ServerConnection, number: int) -> None:
                if number == 1:
                    await connection.close(code=1011)

            tron.on_announced = on_announced
            sessions: list[UUID] = []
            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_connected=sessions.append)
            runner.register("h", handler_ok)
            async with runner:
                while len(sessions) < 2:
                    await asyncio.sleep(0.01)
            assert sessions[0] != sessions[1]
            assert len(tron.announcements) == 2

    run(scenario)


def test_stop_waits_for_the_handler_and_the_report_acknowledgement(tmp_path: Path) -> None:
    async def scenario() -> None:
        delivery_id = uuid4()
        async with FakeTron() as tron:

            async def on_announced(connection: ServerConnection, number: int) -> None:
                await connection.send(work(delivery_id))

            async def on_frame(connection: ServerConnection, received: RunnerFrame) -> None:
                if isinstance(received, protocol.AcceptFrame):
                    await connection.send(accepted(delivery_id, SECRET))
                elif isinstance(received, protocol.ReportFrame):
                    await asyncio.sleep(0.4)
                    await connection.send(report_recorded(delivery_id))

            tron.on_announced, tron.on_frame = on_announced, on_frame
            running = asyncio.Event()
            recorded: list[RecordedReport] = []

            async def handler(delivery: Delivery) -> Outcome:
                running.set()
                await asyncio.sleep(0.3)
                return Ok("drained")

            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_report_recorded=recorded.append)
            runner.register("h", handler)
            await runner.start()
            await running.wait()
            await runner.stop()
            assert recorded == [RecordedReport(delivery_id, False)]

    run(scenario)


def test_several_handlers_cannot_route_a_delivery_so_it_is_not_accepted(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with FakeTron() as tron:

            async def on_announced(connection: ServerConnection, number: int) -> None:
                await connection.send(work(uuid4()))

            tron.on_announced = on_announced
            errors: list[TronRunnerError] = []
            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_error=errors.append)
            runner.register("a", handler_ok)
            runner.register("b", handler_ok)
            async with runner:
                while not errors:
                    await asyncio.sleep(0.01)
            assert isinstance(errors[0], UnroutableDeliveryError)
            assert accepts(tron) == []

    run(scenario)


def test_a_work_frame_with_an_unparseable_timestamp_is_reported_and_the_runner_reconnects(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with FakeTron() as tron:

            async def on_announced(connection: ServerConnection, number: int) -> None:
                if number == 1:
                    await connection.send(work(uuid4(), scheduled_for="not a timestamp"))

            tron.on_announced = on_announced
            errors: list[TronRunnerError] = []
            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_error=errors.append)
            runner.register("h", handler_ok)
            async with runner:
                while tron.connections < 2:
                    await asyncio.sleep(0.01)
            assert isinstance(errors[0], MalformedFrameError)
            assert accepts(tron) == []

    run(scenario)


def test_an_unexpected_failure_while_connecting_ends_start_with_a_typed_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode(*_: object) -> None:
        raise ValueError("unexpected")

    monkeypatch.setattr(Runner, "_on_frame", explode)

    async def scenario() -> None:
        async with FakeTron() as tron:
            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path))
            runner.register("h", handler_ok)
            with pytest.raises(RunnerCrashedError) as raised:
                await runner.start()
            assert isinstance(raised.value.__cause__, ValueError)

    run(scenario)


def test_an_unexpected_failure_after_connecting_is_reported_and_wait_closed_raises_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode(*_: object) -> None:
        raise ValueError("unexpected")

    monkeypatch.setattr(Runner, "_on_work", explode)

    async def scenario() -> None:
        async with FakeTron() as tron:

            async def on_announced(connection: ServerConnection, number: int) -> None:
                await connection.send(work(uuid4()))

            tron.on_announced = on_announced
            errors: list[TronRunnerError] = []
            runner = Runner(tron.url, "good", secret_store=FileSecretStore(tmp_path), on_error=errors.append)
            runner.register("h", handler_ok)
            await runner.start()
            with pytest.raises(RunnerCrashedError):
                await runner.wait_closed()
            assert isinstance(errors[-1], RunnerCrashedError)

    run(scenario)


def test_file_secret_store_keeps_one_private_file_per_delivery(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = FileSecretStore(tmp_path / "secrets")
        first, second = uuid4(), uuid4()
        await store.save(first, "one")
        await store.save(second, "two")
        assert await store.load(first) == "one"
        assert await store.load(uuid4()) is None
        assert sorted(await store.pending()) == sorted([first, second])
        mode = stat.S_IMODE((tmp_path / "secrets" / f"{first}.secret").stat().st_mode)
        assert mode == 0o600
        await store.remove(first)
        await store.remove(first)
        assert await store.pending() == [second]

    run(scenario)
