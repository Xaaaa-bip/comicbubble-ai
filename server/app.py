import asyncio
import base64
from contextlib import asynccontextmanager
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from cache import TranslationCache
from config import CONFIG
from pipeline import ComicCVPipeline
from translator import translate_batch

pipeline = ComicCVPipeline(CONFIG)
cache = TranslationCache(CONFIG.cache_db_path, CONFIG.cache_max_mb) if CONFIG.enable_cache else None
executor = ThreadPoolExecutor(max_workers=CONFIG.max_workers)
infer_semaphore = asyncio.Semaphore(CONFIG.max_workers)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 启动即预热 RapidOCR ONNX 模型，避免首张请求等待 5 秒冷启动
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(executor, pipeline.warmup)
    yield


app = FastAPI(title="ComicBubble AI Self-Hosted Server", version="3.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_token(
    authorization: Optional[str] = Header(default=None),
    x_api_token: Optional[str] = Header(default=None),
) -> None:
    expected = CONFIG.api_token
    if not expected:
        return
    token = ""
    if x_api_token:
        token = x_api_token.strip()
    elif authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if token != expected:
        raise HTTPException(status_code=401, detail="Invalid API token")


class JsonTranslateRequest(BaseModel):
    image_base64: str
    custom_prompt: str = ""
    force: bool = False


def _decode_base64_image(raw: str) -> bytes:
    data = (raw or "").strip()
    if "," in data and data.lower().startswith("data:"):
        data = data.split(",", 1)[1]
    return base64.b64decode(data)


async def _run_full_pipeline(image_bytes: bytes, custom_prompt: str, force: bool) -> dict:
    t0 = time.perf_counter()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image payload")
    if len(image_bytes) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (>25MB)")

    sig = "|".join(
        [
            "v6_fansub_ctx",
            CONFIG.active_translator_name(),
            CONFIG.inpaint_method,
            CONFIG.target_lang,
            CONFIG.custom_prompt,
            (custom_prompt or "").strip(),
        ]
    )

    cache_key = TranslationCache.build_key(image_bytes, sig) if cache else ""
    if cache and not force:
        hit = cache.get(cache_key)
        if hit is not None:
            return {
                "ok": True,
                "cached": True,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
                **hit,
            }

    loop = asyncio.get_running_loop()
    t_ocr0 = time.perf_counter()
    async with infer_semaphore:
        bubbles, img_w, img_h = await loop.run_in_executor(
            executor, pipeline.detect_and_inpaint, image_bytes
        )
    ocr_ms = int((time.perf_counter() - t_ocr0) * 1000)

    engine_used = "none"
    t_tr0 = time.perf_counter()
    if bubbles:
        originals = [b["original"] for b in bubbles]
        kinds = [b.get("bubbleKind", "speech") for b in bubbles]
        translations, engine_used = await translate_batch(originals, CONFIG, custom_prompt, kinds)
        for b, zh in zip(bubbles, translations):
            b["translation"] = zh
    translate_ms = int((time.perf_counter() - t_tr0) * 1000)

    result_data = {
        "imgWidth": img_w,
        "imgHeight": img_h,
        "translator": engine_used,
        "bubbles": bubbles,
    }

    if cache and cache_key:
        cache.set(cache_key, result_data)

    return {
        "ok": True,
        "cached": False,
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        "ocr_ms": ocr_ms,
        "translate_ms": translate_ms,
        **result_data,
    }


@app.get("/health")
async def health(_: None = Depends(verify_token)):
    return {
        "ok": True,
        "service": "ComicBubble AI VPS Backend",
        "detector": "rapidocr-onnxruntime (PP-OCRv4)",
        "inpainter": f"opencv-{CONFIG.inpaint_method}",
        "translator": CONFIG.active_translator_name(),
        "workers": CONFIG.max_workers,
        "cache": cache.stats() if cache else {"enabled": False},
    }


@app.post("/api/v1/translate")
async def translate_upload(
    file: UploadFile = File(...),
    custom_prompt: str = Form(default=""),
    force: bool = Form(default=False),
    _: None = Depends(verify_token),
):
    image_bytes = await file.read()
    return await _run_full_pipeline(image_bytes, custom_prompt, force)


@app.post("/api/v1/translate-json")
async def translate_json(
    req: JsonTranslateRequest,
    _: None = Depends(verify_token),
):
    try:
        image_bytes = _decode_base64_image(req.image_base64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image: {exc}")
    return await _run_full_pipeline(image_bytes, req.custom_prompt, req.force)


@app.post("/api/v1/cache/clear")
async def clear_cache(_: None = Depends(verify_token)):
    if not cache:
        return {"ok": True, "cleared": 0}
    cleared = cache.clear()
    return {"ok": True, "cleared": cleared}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host=CONFIG.host, port=CONFIG.port, workers=1)
