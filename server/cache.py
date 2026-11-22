from contextlib import closing
import hashlib
import json
import os
import sqlite3
import threading
import time
from typing import Any, Optional


class TranslationCache:
    """轻量 SQLite 持久化 LRU 缓存（按图片内容 SHA-256 + 翻译参数签名命中）"""

    def __init__(self, db_path: str, max_mb: int = 500):
        self.db_path = db_path
        self.max_bytes = max(32, max_mb) * 1024 * 1024
        self._lock = threading.Lock()
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._init_db()

    def _connect(self, autocommit: bool = False) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.db_path,
            timeout=15,
            isolation_level=None if autocommit else "",
        )
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _init_db(self) -> None:
        with self._lock, closing(self._connect()) as conn:
            with conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS translations (
                        cache_key TEXT PRIMARY KEY,
                        payload TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        updated_at REAL NOT NULL
                    )
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_translations_updated ON translations(updated_at)"
                )

    @staticmethod
    def build_key(image_bytes: bytes, signature: str) -> str:
        h = hashlib.sha256()
        h.update(image_bytes)
        h.update(b"|")
        h.update(signature.encode("utf-8"))
        return h.hexdigest()

    def get(self, cache_key: str) -> Optional[dict[str, Any]]:
        now = time.time()
        with self._lock, closing(self._connect()) as conn:
            with conn:
                row = conn.execute(
                    "SELECT payload FROM translations WHERE cache_key = ?", (cache_key,)
                ).fetchone()
                if not row:
                    return None
                conn.execute(
                    "UPDATE translations SET updated_at = ? WHERE cache_key = ?", (now, cache_key)
                )
                return json.loads(row[0])

    def set(self, cache_key: str, data: dict[str, Any]) -> None:
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        size_bytes = len(payload.encode("utf-8"))
        now = time.time()
        with self._lock, closing(self._connect()) as conn:
            with conn:
                conn.execute(
                    """
                    INSERT INTO translations (cache_key, payload, size_bytes, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET
                        payload = excluded.payload,
                        size_bytes = excluded.size_bytes,
                        updated_at = excluded.updated_at
                    """,
                    (cache_key, payload, size_bytes, now),
                )
                self._prune_locked(conn)

    def _prune_locked(self, conn: sqlite3.Connection) -> None:
        total = conn.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM translations").fetchone()[0]
        if total <= self.max_bytes:
            return
        target = int(self.max_bytes * 0.85)
        rows = conn.execute(
            "SELECT cache_key, size_bytes FROM translations ORDER BY updated_at ASC"
        ).fetchall()
        to_delete = []
        for k, sz in rows:
            to_delete.append((k,))
            total -= sz
            if total <= target:
                break
        if to_delete:
            conn.executemany("DELETE FROM translations WHERE cache_key = ?", to_delete)

    def stats(self) -> dict[str, Any]:
        with self._lock, closing(self._connect()) as conn:
            count, total_bytes = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM translations"
            ).fetchone()
            return {
                "count": int(count),
                "size_mb": round(total_bytes / (1024 * 1024), 2),
                "max_mb": round(self.max_bytes / (1024 * 1024), 1),
            }

    def clear(self) -> int:
        with self._lock:
            with closing(self._connect()) as conn:
                with conn:
                    count = conn.execute("SELECT COUNT(*) FROM translations").fetchone()[0]
                    conn.execute("DELETE FROM translations")
            with closing(self._connect(autocommit=True)) as conn:
                conn.execute("VACUUM")
            return int(count)
