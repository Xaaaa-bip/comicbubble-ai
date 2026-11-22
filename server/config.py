import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


def _bool_env(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class ServerConfig:
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8765"))
    api_token: str = os.getenv("API_TOKEN", "").strip()
    max_workers: int = max(1, min(8, int(os.getenv("MAX_WORKERS", "2"))))

    translator: str = os.getenv("TRANSLATOR", "auto").strip().lower()
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "https://api.deepseek.com/v1").strip().rstrip("/")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "").strip()
    openai_model: str = os.getenv("OPENAI_MODEL", "deepseek-chat").strip()

    gemini_base_url: str = os.getenv(
        "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
    ).strip().rstrip("/")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "").strip()
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()

    target_lang: str = os.getenv("TARGET_LANG", "zh-CN").strip()
    custom_prompt: str = os.getenv("CUSTOM_PROMPT", "").strip()

    inpaint_method: str = os.getenv("INPAINT_METHOD", "telea").strip().lower()
    ocr_min_score: float = float(os.getenv("OCR_MIN_SCORE", "0.45"))
    max_ocr_width: int = max(800, min(3200, int(os.getenv("MAX_OCR_WIDTH", "1800"))))

    enable_cache: bool = _bool_env("ENABLE_CACHE", True)
    cache_db_path: str = os.getenv("CACHE_DB_PATH", "data/cache.db").strip()
    cache_max_mb: int = max(32, int(os.getenv("CACHE_MAX_MB", "500")))

    def active_translator_name(self) -> str:
        if self.translator == "openai" and self.openai_api_key:
            return f"openai:{self.openai_model}"
        if self.translator == "gemini" and self.gemini_api_key:
            return f"gemini:{self.gemini_model}"
        if self.translator == "google_free":
            return "google_free"
        if self.translator == "mymemory_free":
            return "mymemory_free"
        if self.translator == "transmart_free":
            return "transmart_free"
        # auto 模式
        if self.openai_api_key:
            return f"openai:{self.openai_model}"
        if self.gemini_api_key:
            return f"gemini:{self.gemini_model}"
        return "transmart_free"


CONFIG = ServerConfig()
