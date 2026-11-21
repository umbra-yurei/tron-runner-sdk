"""Persistence of the one-time delivery secret, the only state that must survive a restart."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Protocol
from uuid import UUID

_SUFFIX = ".secret"


class SecretStore(Protocol):
    """Where accepted deliveries' secrets live until their report is recorded.

    Implement this to keep secrets in a database or a secret manager.
    """

    async def save(self, delivery_id: UUID, secret: str) -> None: ...

    async def load(self, delivery_id: UUID) -> str | None: ...

    async def remove(self, delivery_id: UUID) -> None: ...

    async def pending(self) -> list[UUID]:
        """Deliveries that were accepted and not yet reported."""
        ...


class FileSecretStore:
    """The default store: one `0600` file per delivery in a directory the caller chooses."""

    def __init__(self, directory: str | os.PathLike[str]) -> None:
        self._directory = Path(directory)
        self._directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, delivery_id: UUID) -> Path:
        return self._directory / f"{delivery_id}{_SUFFIX}"

    async def save(self, delivery_id: UUID, secret: str) -> None:
        await asyncio.to_thread(self._save, delivery_id, secret)

    def _save(self, delivery_id: UUID, secret: str) -> None:
        path = self._path(delivery_id)
        temporary = path.with_name(f".{path.name}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(secret)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    async def load(self, delivery_id: UUID) -> str | None:
        return await asyncio.to_thread(self._load, delivery_id)

    def _load(self, delivery_id: UUID) -> str | None:
        try:
            return self._path(delivery_id).read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    async def remove(self, delivery_id: UUID) -> None:
        await asyncio.to_thread(self._path(delivery_id).unlink, True)

    async def pending(self) -> list[UUID]:
        return await asyncio.to_thread(self._pending)

    def _pending(self) -> list[UUID]:
        found: list[UUID] = []
        for entry in self._directory.glob(f"*{_SUFFIX}"):
            try:
                found.append(UUID(entry.name.removesuffix(_SUFFIX)))
            except ValueError:
                continue
        return sorted(found)
