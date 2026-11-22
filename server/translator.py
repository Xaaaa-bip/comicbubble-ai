from collections import deque
import asyncio
import json
import re
import time
from typing import List, Optional
import httpx

from config import ServerConfig

# 滚动前文记忆（保留最近 10 分钟内至多 14 条已翻对白，保持条漫跨屏人名/家族/称谓一致）
_RECENT_CONTEXT: deque = deque(maxlen=14)
_CONTEXT_TTL_SEC = 600.0


def _get_recent_context_lines() -> List[dict]:
    now = time.time()
    return [{"en": en, "zh": zh} for ts, en, zh in _RECENT_CONTEXT if now - ts <= _CONTEXT_TTL_SEC]


def _remember_context(originals: List[str], translations: List[str]) -> None:
    now = time.time()
    for en, zh in zip(originals, translations):
        en_s = (en or "").strip()
        zh_s = (zh or "").strip()
        if en_s and zh_s and en_s != zh_s:
            _RECENT_CONTEXT.append((now, en_s[:140], zh_s[:140]))


def _extract_json_array(raw: str) -> Optional[list]:
    text = (raw or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    try:
        parsed = json.loads(text)
    except Exception:
        s = text.find("{")
        e = text.rfind("}")
        if s != -1 and e > s:
            try:
                parsed = json.loads(text[s : e + 1])
            except Exception:
                return None
        else:
            s2 = text.find("[")
            e2 = text.rfind("]")
            if s2 != -1 and e2 > s2:
                try:
                    parsed = json.loads(text[s2 : e2 + 1])
                except Exception:
                    return None
            else:
                return None

    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("translations", "items", "bubbles", "results"):
            if isinstance(parsed.get(key), list):
                return parsed[key]
    return None


FANSUB_SYSTEM_PROMPT = """你是一位国内顶级韩漫/美漫汉化组主翻兼润色（擅长奇幻、热血、动作、都市等全题材条漫）。
你的任务是把 OCR 提取的英文漫画气泡文本，还原原意后意译为**极其地道、自然、有画面感与情绪张力的简体中文漫画台词**。

核心汉化铁律：
1. **OCR 纠错与还原**：输入文本来自漫画 OCR，经常出现全大写、单词粘连漏空格（如 USBEINGFROMTHESAMEHOUSE → us being from the same house）、标点缺失或形近字误识（I/l/1、O/0、rn/m），务必先结合前后气泡语境自动脑补还原真实英文句意再翻译。
2. **彻底消灭翻译腔**：
   - 严禁机翻直译句式（如“作为负责……的军官”、“尽管……但是……”、“我的天啊”、“哦，不”、“该死的，你做了什么”）。
   - 善用自然中文口语、倒装、反问、省略和语气词（如「偏偏派她来护送我？」「明明同出一门……」「搞什么鬼」「完蛋了」「少废话」）。
   - 奇幻/韩漫高频词按语境地道意译：如 House → 家族/世家（绝不译成房子），Master/Young Master → 大人/家主/少爷，Aura/Mana → 斗气/魔力，Officer/Commander → 负责人/统领/长官。
3. **按气泡类型 (`kind`) 切换语气**：
   - `speech`（对白气泡）：鲜活口语，贴合角色性格与情绪，简短有力；
   - `narration`（方框旁白/心理独白）：精炼有叙事感或内心吐槽感，流畅自然；
   - `shout`（大字号喊叫/爆发）：短促炸裂，有冲击力，善用感叹号或破折号。
4. **跨气泡连贯切分**：如果相邻几个 `id` 明显是同一句话被拆成多段气泡，请先整体理解完整意思，再按中文自然语序和阅读停顿合理拆分回对应的 `id`，做到上下连读丝滑、不重复主语、不留悬空介词。
5. **人名与术语前后统一**：严格参考给出的“前文译名参考”保持同一角色、家族、地名、称谓（你/您/少爷/大人）全话统一；纯英文人名/姓氏音译成流畅中文（如 Isabella La Baskerville → 伊莎贝拉·拉·巴斯克维尔）。
6. **简洁适配气泡**：译文凝练不啰嗦，尽量贴合气泡字数容量，不要无端扩写。
7. **严格输出 JSON**：必须按原始 `id` 一一对应返回，绝不漏项或增项，格式固定为：{"translations":[{"id":0,"zh":"..."},...]}"""


def _build_batch_prompt(
    texts: List[str],
    custom_prompt: str = "",
    kinds: Optional[List[str]] = None,
) -> str:
    items = []
    for idx, t in enumerate(texts):
        entry = {"id": idx, "en": t}
        if kinds and idx < len(kinds) and kinds[idx]:
            entry["kind"] = kinds[idx]
        items.append(entry)

    ctx_lines = _get_recent_context_lines()
    ctx_block = ""
    if ctx_lines:
        ctx_block = (
            "【前文译名与语境参考（仅供保持人名/称谓/剧情连贯，不要翻译这一段）】：\n"
            + json.dumps(ctx_lines[-10:], ensure_ascii=False)
            + "\n\n"
        )

    extra = f"【用户专属术语/译风要求】：\n{custom_prompt.strip()}\n\n" if custom_prompt.strip() else ""
    return (
        f"{ctx_block}{extra}"
        "【当前待翻译气泡（按漫画阅读顺序排列，请输出严格 JSON）】：\n"
        f"{json.dumps(items, ensure_ascii=False)}"
    )


async def _translate_openai(
    texts: List[str],
    cfg: ServerConfig,
    custom_prompt: str,
    kinds: Optional[List[str]] = None,
) -> List[str]:
    endpoint = (
        cfg.openai_base_url
        if cfg.openai_base_url.endswith("/chat/completions")
        else f"{cfg.openai_base_url}/chat/completions"
    )
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.openai_api_key}",
    }
    prompt = _build_batch_prompt(texts, custom_prompt, kinds)
    payload = {
        "model": cfg.openai_model,
        "temperature": 0.65,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": FANSUB_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }

    client = _get_shared_client()
    resp = await client.post(endpoint, headers=headers, json=payload, timeout=45.0)
    if resp.status_code == 400 and "response_format" in resp.text:
        payload.pop("response_format", None)
        resp = await client.post(endpoint, headers=headers, json=payload, timeout=45.0)
    resp.raise_for_status()
    data = resp.json()

    content = data["choices"][0]["message"]["content"]
    arr = _extract_json_array(content)
    if not arr:
        raise RuntimeError("OpenAI 兼容接口未返回有效 JSON 翻译列表")
    return _map_translations(texts, arr)


async def _translate_gemini(
    texts: List[str],
    cfg: ServerConfig,
    custom_prompt: str,
    kinds: Optional[List[str]] = None,
) -> List[str]:
    endpoint = (
        f"{cfg.gemini_base_url}/models/{cfg.gemini_model}:generateContent"
        f"?key={cfg.gemini_api_key}"
    )
    prompt = _build_batch_prompt(texts, custom_prompt, kinds)
    payload = {
        "systemInstruction": {"parts": [{"text": FANSUB_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.65,
            "responseMimeType": "application/json",
        },
    }
    client = _get_shared_client()
    resp = await client.post(endpoint, json=payload, timeout=45.0)
    resp.raise_for_status()
    data = resp.json()

    parts = data["candidates"][0]["content"]["parts"]
    raw_text = "".join(p.get("text", "") for p in parts)
    arr = _extract_json_array(raw_text)
    if not arr:
        raise RuntimeError("Gemini 接口未返回有效 JSON 翻译列表")
    return _map_translations(texts, arr)


def _map_translations(texts: List[str], arr: list) -> List[str]:
    by_id = {}
    for idx, item in enumerate(arr):
        if isinstance(item, dict):
            tid = item.get("id", idx)
            zh = item.get("zh") or item.get("translation") or item.get("text") or ""
            try:
                by_id[int(tid)] = str(zh).strip()
            except Exception:
                by_id[idx] = str(zh).strip()
        elif isinstance(item, str):
            by_id[idx] = item.strip()

    out = []
    for i, orig in enumerate(texts):
        out.append(by_id.get(i) or orig)
    return out


async def _translate_one_google_free(client: httpx.AsyncClient, text: str, target_lang: str) -> str:
    url = "https://translate.googleapis.com/translate_a/single"
    params = {
        "client": "gtx",
        "sl": "en",
        "tl": target_lang or "zh-CN",
        "dt": "t",
        "q": text,
    }
    resp = await client.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, list) and data and isinstance(data[0], list):
        return "".join(seg[0] for seg in data[0] if isinstance(seg, list) and seg and seg[0]).strip()
    return text


async def _translate_google_free(texts: List[str], target_lang: str) -> List[str]:
    async with httpx.AsyncClient(
        timeout=20.0,
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"},
    ) as client:
        sem = asyncio.Semaphore(5)

        async def run_one(t: str) -> str:
            async with sem:
                try:
                    return await _translate_one_google_free(client, t, target_lang)
                except Exception:
                    return t

        return list(await asyncio.gather(*(run_one(t) for t in texts)))


_SHARED_CLIENT: Optional[httpx.AsyncClient] = None


def _get_shared_client() -> httpx.AsyncClient:
    global _SHARED_CLIENT
    if _SHARED_CLIENT is None or _SHARED_CLIENT.is_closed:
        _SHARED_CLIENT = httpx.AsyncClient(
            timeout=15.0,
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
    return _SHARED_CLIENT


def _normalize_comic_allcaps(text: str) -> str:
    """英文漫画常全大写（ALL CAPS），适度转为常规大小写可大幅提升神经机器翻译准确度"""
    t = (text or "").strip()
    letters = [c for c in t if c.isalpha()]
    if len(letters) < 4:
        return t
    upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    if upper_ratio < 0.85:
        return t
    lowered = t.lower()
    # 句首及标点后首字母大写
    res = re.sub(r"(^|[.!?…]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), lowered)
    # 英文第一人称代词 I / I'm / I'll / I've / I'd 保持大写
    res = re.sub(r"\bi(?=(?:['’](?:m|ll|ve|d|re)|[^a-zA-Z]|$))", "I", res)
    return res


async def _translate_transmart_free(texts: List[str], target_lang: str) -> Optional[List[str]]:
    """腾讯交互翻译 TranSmart（国内直连 ~200-350ms，原生 JSON 批量数组，人名/句意显著优于 MyMemory）"""
    tl = "zh" if (target_lang or "zh-CN").lower().startswith("zh") else target_lang
    norm_texts = [_normalize_comic_allcaps(t) for t in texts]
    client = _get_shared_client()
    try:
        resp = await client.post(
            "https://transmart.qq.com/api/imt",
            headers={
                "Content-Type": "application/json",
                "Referer": "https://transmart.qq.com/",
            },
            json={
                "header": {
                    "fn": "auto_translation",
                    "client_key": "browser-chrome-120.0.0-Windows-10",
                },
                "type": "plain",
                "model_category": "normal",
                "source": {"lang": "en", "text_list": norm_texts},
                "target": {"lang": tl},
            },
            timeout=8.0,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        arr = data.get("auto_translation")
        if isinstance(arr, list) and len(arr) == len(texts):
            return [str(x or orig).strip() for x, orig in zip(arr, texts)]
    except Exception:
        return None
    return None


async def _translate_mymemory_chunk(client: httpx.AsyncClient, chunk: List[str], target_lang: str) -> List[str]:
    """将多条气泡打包为 1 次 HTTP 请求（受 MyMemory 500 字符上限约束），显著降低 RTT"""
    url = "https://api.mymemory.translated.net/get"
    tl = target_lang or "zh-CN"
    clean_chunk = [t.replace("\n", " ").strip() for t in chunk]
    joined = "\n".join(clean_chunk)
    try:
        resp = await client.get(url, params={"q": joined, "langpair": f"en|{tl}"})
        resp.raise_for_status()
        data = resp.json()
        translated = str((data.get("responseData") or {}).get("translatedText") or "").strip()
        if translated and not translated.upper().startswith("MYMEMORY WARNING"):
            lines = [ln.strip() for ln in translated.splitlines() if ln.strip()]
            if len(lines) == len(clean_chunk):
                return lines
    except Exception:
        pass

    # 若批量行数被合并或异常，回退并发单条翻译
    async def one(text: str) -> str:
        try:
            r = await client.get(url, params={"q": text, "langpair": f"en|{tl}"})
            r.raise_for_status()
            tr = str((r.json().get("responseData") or {}).get("translatedText") or "").strip()
            if tr and not tr.upper().startswith("MYMEMORY WARNING"):
                return tr
        except Exception:
            pass
        return text

    return list(await asyncio.gather(*(one(t) for t in clean_chunk)))


async def _translate_mymemory_free(texts: List[str], target_lang: str) -> List[str]:
    # 按 <= 420 字符切分为最少批次，共享 HTTP/1.1 Keep-Alive 并发发出
    chunks: List[List[str]] = []
    cur: List[str] = []
    cur_len = 0
    for t in texts:
        t_clean = t.replace("\n", " ").strip()
        add_len = len(t_clean) + (1 if cur else 0)
        if cur and cur_len + add_len > 420:
            chunks.append(cur)
            cur = [t_clean]
            cur_len = len(t_clean)
        else:
            cur.append(t_clean)
            cur_len += add_len
    if cur:
        chunks.append(cur)

    async with httpx.AsyncClient(
        timeout=15.0,
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"},
    ) as client:
        sem = asyncio.Semaphore(4)

        async def run_chunk(ch: List[str]) -> List[str]:
            async with sem:
                return await _translate_mymemory_chunk(client, ch, target_lang)

        results = await asyncio.gather(*(run_chunk(ch) for ch in chunks))
        flat: List[str] = []
        for part in results:
            flat.extend(part)
        return flat


async def translate_batch(
    texts: List[str],
    cfg: ServerConfig,
    custom_prompt: str = "",
    kinds: Optional[List[str]] = None,
) -> tuple[List[str], str]:
    """根据配置批量翻译整页漫画气泡，返回 (译文列表, 实际使用的引擎标识)"""
    if not texts:
        return [], "none"

    merged_prompt = "\n".join(p for p in (cfg.custom_prompt, custom_prompt) if p and p.strip())
    mode = cfg.translator

    if mode == "openai" or (mode == "auto" and cfg.openai_api_key):
        if cfg.openai_api_key:
            try:
                res = await _translate_openai(texts, cfg, merged_prompt, kinds)
                _remember_context(texts, res)
                return res, f"openai:{cfg.openai_model}"
            except Exception:
                if mode == "openai":
                    raise

    if mode == "gemini" or (mode == "auto" and cfg.gemini_api_key):
        if cfg.gemini_api_key:
            try:
                res = await _translate_gemini(texts, cfg, merged_prompt, kinds)
                _remember_context(texts, res)
                return res, f"gemini:{cfg.gemini_model}"
            except Exception:
                if mode == "gemini":
                    raise

    if mode == "google_free":
        res = await _translate_google_free(texts, cfg.target_lang)
        _remember_context(texts, res)
        return res, "google_free"

    if mode == "mymemory_free":
        res = await _translate_mymemory_free(texts, cfg.target_lang)
        _remember_context(texts, res)
        return res, "mymemory_free"

    # auto / transmart_free：优先腾讯 TranSmart（国内 ~250ms 批量极速），失败自动回退 MyMemory -> Google
    tm_res = await _translate_transmart_free(texts, cfg.target_lang)
    if tm_res is not None:
        _remember_context(texts, tm_res)
        return tm_res, "transmart_free"

    res = await _translate_mymemory_free(texts, cfg.target_lang)
    if any(zh != en for zh, en in zip(res, texts)):
        _remember_context(texts, res)
        return res, "mymemory_free"

    res_g = await _translate_google_free(texts, cfg.target_lang)
    _remember_context(texts, res_g)
    return res_g, "google_free"
