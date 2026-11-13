"""SQLite storage for a local single-user prototype (no multi-tenant guarantees).

Writes are done in transactions; a run is only 'complete' after an explicit finish flag, so partial
runs never enter test reports.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, body TEXT NOT NULL,
  config_hash TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, scenario_id TEXT, config_hash TEXT, versions TEXT NOT NULL,
  status TEXT NOT NULL, created_at REAL NOT NULL, finished_at REAL
);
CREATE TABLE IF NOT EXISTS measurement_batches (
  run_id TEXT NOT NULL, batch_key TEXT NOT NULL, first_seq INTEGER, last_seq INTEGER, n INTEGER NOT NULL,
  body TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (run_id, batch_key)
);
CREATE TABLE IF NOT EXISTS truth_records (run_id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS diagnoses (
  run_id TEXT NOT NULL, detector TEXT NOT NULL, sim_time REAL NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diag_run ON diagnoses(run_id, detector, sim_time);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0, message TEXT, result TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            c = sqlite3.connect(self.path, timeout=30)
            c.row_factory = sqlite3.Row
            try:
                yield c
                c.commit()
            except Exception:
                c.rollback()
                raise
            finally:
                c.close()

    # -------------------------------------------------------------- generic helpers
    def query(self, sql: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self.conn() as c:
            return list(c.execute(sql, args).fetchall())

    def execute(self, sql: str, args: tuple[Any, ...] = ()) -> int:
        with self.conn() as c:
            cur = c.execute(sql, args)
            return cur.rowcount


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def now() -> float:
    return time.time()
