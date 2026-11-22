from collections import deque
import asyncio
import json
import re
import time
from typing import Dict, List, Optional, Tuple
import httpx

from config import ServerConfig

# 按漫画作品隔离的滚动前文记忆（保留最近 15 分钟内至多 16 条已翻对白，保证跨屏语气/称谓/剧情连贯）
_SERIES_CONTEXT: Dict[str, deque] = {}
_CONTEXT_TTL_SEC = 900.0


def _get_recent_context_lines(series_key: str) -> List[dict]:
    dq = _SERIES_CONTEXT.get(series_key or "default")
    if not dq:
        return []
    now = time.time()
    return [{"en": en, "zh": zh} for ts, en, zh in dq if now - ts <= _CONTEXT_TTL_SEC]


def _remember_context(series_key: str, originals: List[str], translations: List[str]) -> None:
    key = series_key or "default"
    dq = _SERIES_CONTEXT.setdefault(key, deque(maxlen=16))
    now = time.time()
    for en, zh in zip(originals, translations):
        en_s = (en or "").strip()
        zh_s = (zh or "").strip()
        if en_s and zh_s and en_s != zh_s:
            dq.append((now, en_s[:140], zh_s[:140]))


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


def _extract_json_obj(raw: str) -> Optional[dict]:
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
            return None
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, list):
        return {"translations": parsed}
    return None


OFFICIAL_LOCALIZATION_PROMPT = """你是哔哩哔哩漫画 / 快看漫画 / 腾讯动漫官方签约正版韩漫、美漫资深本地化主笔（精翻+终审润色）。
你的目标不是“字面翻译英文”，而是产出**直接达到正版官方平台上线水准**的简体中文漫画台词。

核心本地化铁律：
1. **激活作品官方设定（最关键）**：
   - 你会收到当前漫画的【作品信息（网页标题/章节）】。如果这是你熟知的知名韩漫/日漫/网文改编作（例如 *Revenge of the Iron-Blooded Sword Hound* 即正版《铁血剑家猎犬的回归》：主角「维基尔」、家族「巴斯克维尔」、骑士团长「伊莎贝拉」、大监狱「努贝尔瓦格」等），**必须主动使用该作公认的官方中文译名、专有地名/势力名，并严格贴合原作主角与角色的性格基调**（如冷峻克制、傲慢凌厉、杀伐果断等）。
   - 严禁把作品里的法语/外语专有地名、人名、组织名做字面直译（例如监狱名 `Nouvelle Vague` 绝不能直译成「新浪潮」，应译作「努贝尔瓦格」）。
2. **彻底洗掉“韩→英→中”二手英翻腔**：
   - 大量英文版条漫本身是由韩文转译的，充斥英语长定语从句与书面转折（如 `assigned as the officer in charge of escorting me to ... despite us being from the same house`）。
   - **绝对禁止顺着英文语序直译！** 先在脑中还原漫画场景与潜台词，再彻底打散重组为**中文奇幻/热血漫画的原生语感**：
     - 善用精准有张力的动词与短词（押送/押解而非陪同，同族/一门而非来自同一个家族，家主/统领/押送官而非负责人，魔力石/魔力水晶，世家而非房子）。
     - 多用精炼短句、反问、冷笑、留白与中文网文/漫画节奏，删掉多余主语和“的/这/那/尽管……但是……”。
     - 对比示例：
       - ❌ 生硬直译：「尽管我们来自同一个家族，她还是被指派为负责护送我去新浪潮的军官？」
       - ✅ 官方水准：「同为巴斯克维尔一族，竟派她亲自押送我去努贝尔瓦格？」
3. **OCR 纠错与跨气泡连读**：
   - 输入来自漫画 OCR，可能出现全大写、单词粘连漏空格（如 `USBEINGFROMTHESAMEHOUSE`）或个别形近字误识（`I/l/1`、`O/0`、`rn/m`），先自动还原真实英文句意再意译。
   - 若相邻 `id` 明显是被拆成多个气泡的同一句话，先整体理解，再按中文自然停顿流畅拆分回各 `id`，保证上下格连读丝滑无断层。
4. **按气泡类型 (`kind`) 精准控腔**：
   - `narration`（旁白/冷峻独白）：凝练、有文学/史诗/冷冽叙事张力；
   - `shout`（大字号爆发）：极短促炸裂，直击情绪；
   - `speech`（角色对白）：活人感强，符合人物阶级与当下冲突（上位者威压、下位者敬畏、宿敌嘲讽）。
5. **100% 锁死术语一致性**：
   - 凡是【本作已锁定术语表】中出现的专词，**必须一字不差沿用**。
   - 若本屏新出现重要人名、家族、地名、组织、魔物、核心设定词（普通日常词不要收），请在返回 JSON 的 `new_terms` 字典中列出 `{"English": "锁定中文"}`，供后续章节永久沿用。
6. **简洁适配气泡 + 严格 JSON 输出**：
   - 译文凝练，不无端扩写撑爆气泡。
   - 严格返回合法 JSON，按原始 `id` 一一对应不漏项，格式：
     {"translations":[{"id":0,"zh":"..."},...],"new_terms":{"English Term":"锁定中文"}}"""


def _build_batch_prompt(
    texts: List[str],
    custom_prompt: str = "",
    kinds: Optional[List[str]] = None,
    page_title: str = "",
    series_key: str = "default",
    glossary: Optional[Dict[str, str]] = None,
) -> str:
    items = []
    for idx, t in enumerate(texts):
        entry = {"id": idx, "en": t}
        if kinds and idx < len(kinds) and kinds[idx]:
            entry["kind"] = kinds[idx]
        items.append(entry)

    sections = []
    if page_title.strip() or (series_key and series_key != "default"):
        info = page_title.strip() or series_key
        sections.append(f"【当前漫画作品与章节】：{info}")

    if glossary:
        sections.append(
            "【本作已锁定术语表（必须严格沿用，禁止随意改译）】：\n"
            + json.dumps(glossary, ensure_ascii=False)
        )

    ctx_lines = _get_recent_context_lines(series_key)
    if ctx_lines:
        sections.append(
            "【前文已翻对白参考（用于承接语境与称谓，不要重复翻译）】：\n"
            + json.dumps(ctx_lines[-10:], ensure_ascii=False)
        )

    if custom_prompt.strip():
        sections.append(f"【用户专属译名/译风指令】：\n{custom_prompt.strip()}")

    sections.append(
        "【当前待本地化气泡（按阅读顺序排列，请输出严格 JSON）】：\n"
        + json.dumps(items, ensure_ascii=False)
    )
    return "\n\n".join(sections)


def _parse_llm_response(texts: List[str], raw_content: str) -> Tuple[List[str], Dict[str, str]]:
    obj = _extract_json_obj(raw_content)
    if not obj:
        raise RuntimeError("LLM 未返回有效 JSON")
    arr = None
    for key in ("translations", "items", "bubbles", "results"):
        if isinstance(obj.get(key), list):
            arr = obj[key]
            break
    if not arr:
        raise RuntimeError("LLM 返回 JSON 缺少 translations 列表")
    new_terms: Dict[str, str] = {}
    raw_terms = obj.get("new_terms")
    if isinstance(raw_terms, dict):
        for k, v in raw_terms.items():
            if isinstance(k, str) and isinstance(v, str) and k.strip() and v.strip():
                new_terms[k.strip()] = v.strip()
    return _map_translations(texts, arr), new_terms


async def _translate_openai(
    texts: List[str],
    cfg: ServerConfig,
    custom_prompt: str,
    kinds: Optional[List[str]] = None,
    page_title: str = "",
    series_key: str = "default",
    glossary: Optional[Dict[str, str]] = None,
) -> Tuple[List[str], Dict[str, str]]:
    endpoint = (
        cfg.openai_base_url
        if cfg.openai_base_url.endswith("/chat/completions")
        else f"{cfg.openai_base_url}/chat/completions"
    )
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.openai_api_key}",
    }
    prompt = _build_batch_prompt(texts, custom_prompt, kinds, page_title, series_key, glossary)
    payload = {
        "model": cfg.openai_model,
        "temperature": 0.72,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": OFFICIAL_LOCALIZATION_PROMPT},
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
    return _parse_llm_response(texts, content)


async def _translate_gemini(
    texts: List[str],
    cfg: ServerConfig,
    custom_prompt: str,
    kinds: Optional[List[str]] = None,
    page_title: str = "",
    series_key: str = "default",
    glossary: Optional[Dict[str, str]] = None,
) -> Tuple[List[str], Dict[str, str]]:
    endpoint = (
        f"{cfg.gemini_base_url}/models/{cfg.gemini_model}:generateContent"
        f"?key={cfg.gemini_api_key}"
    )
    prompt = _build_batch_prompt(texts, custom_prompt, kinds, page_title, series_key, glossary)
    payload = {
        "systemInstruction": {"parts": [{"text": OFFICIAL_LOCALIZATION_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.72,
            "responseMimeType": "application/json",
        },
    }
    client = _get_shared_client()
    resp = await client.post(endpoint, json=payload, timeout=45.0)
    resp.raise_for_status()
    data = resp.json()

    parts = data["candidates"][0]["content"]["parts"]
    raw_text = "".join(p.get("text", "") for p in parts)
    return _parse_llm_response(texts, raw_text)


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
    page_title: str = "",
    series_key: str = "default",
    glossary: Optional[Dict[str, str]] = None,
) -> Tuple[List[str], str, Dict[str, str]]:
    """根据配置批量本地化整页漫画气泡，返回 (译文列表, 实际使用的引擎标识, 本屏新提取专词字典)"""
    if not texts:
        return [], "none", {}

    merged_prompt = "\n".join(p for p in (cfg.custom_prompt, custom_prompt) if p and p.strip())
    mode = cfg.translator

    if mode == "openai" or (mode == "auto" and cfg.openai_api_key):
        if cfg.openai_api_key:
            try:
                res, new_terms = await _translate_openai(
                    texts, cfg, merged_prompt, kinds, page_title, series_key, glossary
                )
                _remember_context(series_key, texts, res)
                return res, f"openai:{cfg.openai_model}", new_terms
            except Exception:
                if mode == "openai":
                    raise

    if mode == "gemini" or (mode == "auto" and cfg.gemini_api_key):
        if cfg.gemini_api_key:
            try:
                res, new_terms = await _translate_gemini(
                    texts, cfg, merged_prompt, kinds, page_title, series_key, glossary
                )
                _remember_context(series_key, texts, res)
                return res, f"gemini:{cfg.gemini_model}", new_terms
            except Exception:
                if mode == "gemini":
                    raise

    if mode == "google_free":
        res = await _translate_google_free(texts, cfg.target_lang)
        _remember_context(series_key, texts, res)
        return res, "google_free", {}

    if mode == "mymemory_free":
        res = await _translate_mymemory_free(texts, cfg.target_lang)
        _remember_context(series_key, texts, res)
        return res, "mymemory_free", {}

    tm_res = await _translate_transmart_free(texts, cfg.target_lang)
    if tm_res is not None:
        _remember_context(series_key, texts, tm_res)
        return tm_res, "transmart_free", {}

    res = await _translate_mymemory_free(texts, cfg.target_lang)
    if any(zh != en for zh, en in zip(res, texts)):
        _remember_context(series_key, texts, res)
        return res, "mymemory_free", {}

    res_g = await _translate_google_free(texts, cfg.target_lang)
    _remember_context(series_key, texts, res_g)
    return res_g, "google_free", {}
