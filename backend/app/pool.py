"""A small process pool with per-task timeouts that can kill runaway work."""

from __future__ import annotations

import asyncio
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool


class JobTimeout(Exception):
    pass


class WorkerCrashed(Exception):
    pass


def _warm() -> bool:
    # Import the heavy modules once so the first real request is fast.
    import relief.pipeline  # noqa: F401
    import relief.export  # noqa: F401
    import sklearn.cluster  # noqa: F401

    return True


class WorkerPool:
    def __init__(self, workers: int):
        self._workers = max(1, workers)
        self._pool = self._new()
        self._sem = asyncio.Semaphore(self._workers)

    def _new(self) -> ProcessPoolExecutor:
        # "spawn" avoids forking a process that has threads (uvicorn), on every platform.
        return ProcessPoolExecutor(
            max_workers=self._workers, mp_context=multiprocessing.get_context("spawn"), max_tasks_per_child=25
        )

    def warm_up(self) -> None:
        for _ in range(self._workers):
            self._pool.submit(_warm)

    @property
    def busy(self) -> int:
        return self._workers - self._sem._value  # noqa: SLF001 - informational only

    async def run(self, fn, *args, timeout: float):
        async with self._sem:
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(self._pool, fn, *args)
            try:
                return await asyncio.wait_for(future, timeout)
            except asyncio.TimeoutError:
                self._restart()
                raise JobTimeout() from None
            except BrokenProcessPool as exc:
                self._restart()
                raise WorkerCrashed() from exc

    def _restart(self) -> None:
        """Kill the worker processes (the only way to stop a running task) and start fresh."""
        old = self._pool
        self._pool = self._new()
        for proc in list(getattr(old, "_processes", {}).values()):
            try:
                proc.terminate()
            except Exception:
                pass
        old.shutdown(wait=False, cancel_futures=True)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
