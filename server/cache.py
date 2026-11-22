from contextlib import closing
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import urlparse


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
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS series_glossary (
                        series_key TEXT NOT NULL,
                        term_en TEXT NOT NULL,
                        term_zh TEXT NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY (series_key, term_en)
                    )
                    """
                )

    @staticmethod
    def extract_series_key(page_title: str = "", page_url: str = "") -> str:
        """从漫画 URL 路径或网页标题提取统一的作品标识（同一部漫画不同话共享术语表）"""
        if page_url:
            try:
                path = urlparse(page_url).path.strip("/")
                segs = [s for s in path.split("/") if s]
                # 常见漫画站路径: /webtoon/<slug>/chapter-189 或 /manga/<slug>/ch-12
                for idx, seg in enumerate(segs):
                    if seg.lower() in ("webtoon", "manga", "comic", "series", "title", "manhwa") and idx + 1 < len(segs):
                        slug = re.sub(r"[^a-z0-9\-_]+", "", segs[idx + 1].lower())
                        if len(slug) >= 3:
                            return slug[:80]
                # 退化：取不含 chapter/ep 的最长有效段
                cleaned = [
                    s.lower()
                    for s in segs
                    if not re.match(r"^(chapter|ch|ep|episode|vol|v)[\-_]?\d+", s, re.I)
                ]
                if cleaned:
                    best = max(cleaned, key=len)
                    slug = re.sub(r"[^a-z0-9\-_\u4e00-\u9fff]+", "", best)
                    if len(slug) >= 3:
                        return slug[:80]
            except Exception:
                pass

        if page_title:
            t = re.sub(r"^\s*read\s+", "", page_title, flags=re.I)
            t = re.split(r"\s*[-–—|:]\s*(?:chapter|ch\.?|ep\.?|episode|\d+)", t, maxsplit=1, flags=re.I)[0]
            t = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", t.lower()).strip("-")
            if len(t) >= 2:
                return t[:80]
        return "default"

    def get_glossary(self, series_key: str, limit: int = 50) -> Dict[str, str]:
        if not series_key or series_key == "default":
            return {}
        with self._lock, closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT term_en, term_zh FROM series_glossary WHERE series_key = ? ORDER BY updated_at ASC LIMIT ?",
                (series_key, limit),
            ).fetchall()
            return {r[0]: r[1] for r in rows}

    def upsert_glossary(self, series_key: str, terms: Dict[str, str]) -> int:
        """首次出现即锁定译名（INSERT OR IGNORE），防止多线程并发或跨话漂移"""
        if not series_key or series_key == "default" or not terms:
            return 0
        now = time.time()
        rows = []
        for en, zh in terms.items():
            en_s = re.sub(r"\s+", " ", str(en or "").strip())
            zh_s = str(zh or "").strip()
            if 2 <= len(en_s) <= 48 and 1 <= len(zh_s) <= 24 and en_s.lower() != zh_s.lower():
                rows.append((series_key, en_s, zh_s, now))
        if not rows:
            return 0
        with self._lock, closing(self._connect()) as conn:
            with conn:
                conn.executemany(
                    """
                    INSERT OR IGNORE INTO series_glossary (series_key, term_en, term_zh, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    rows,
                )
        return len(rows)

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
