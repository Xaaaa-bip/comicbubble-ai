'use strict';

importScripts('../shared/config.js');

const CACHE_PREFIX = 'cb_cache_item_';
const CACHE_INDEX_KEY = 'cb_cache_index_v1';
const MAX_CACHE_ITEMS = 80;
const CONTEXT_MENU_ID = 'comicbubble-translate-target';

// -------------------- 右键菜单（支持 img、canvas、背景图 div） --------------------

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: '使用 ComicBubble AI 翻译此漫画画面',
      contexts: ['image', 'page']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => setupContextMenu());
chrome.runtime.onStartup.addListener(() => setupContextMenu());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || !tab.id) return;
  chrome.tabs.sendMessage(
    tab.id,
    {
      type: 'TRANSLATE_SINGLE_IMAGE',
      srcUrl: info.srcUrl || '',
      force: true
    },
    { frameId: typeof info.frameId === 'number' ? info.frameId : undefined },
    () => {
      void chrome.runtime.lastError;
    }
  );
});

// -------------------- 本地 LRU 缓存 --------------------

function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildCacheKey(imageKey, settings) {
  const engineId =
    settings.provider === 'vps'
      ? `vps:${settings.vpsBaseUrl}`
      : settings.provider === 'gemini'
        ? `gemini:${settings.geminiModel}`
        : `openai:${settings.openaiModel}`;
  const sig = [
    'v8_official_loc',
    imageKey,
    engineId,
    settings.translateSfx ? 'sfx1' : 'sfx0',
    (settings.customPrompt || '').trim()
  ].join('|');
  return CACHE_PREFIX + fnv1aHash(sig) + '_' + sig.length;
}

async function getCache(cacheKey) {
  const res = await chrome.storage.local.get(cacheKey);
  return res[cacheKey] || null;
}

async function setCache(cacheKey, data) {
  const indexRes = await chrome.storage.local.get(CACHE_INDEX_KEY);
  let index = Array.isArray(indexRes[CACHE_INDEX_KEY]) ? indexRes[CACHE_INDEX_KEY] : [];
  index = index.filter((item) => item.key !== cacheKey);
  index.push({ key: cacheKey, ts: Date.now() });

  const keysToRemove = [];
  while (index.length > MAX_CACHE_ITEMS) {
    const oldest = index.shift();
    if (oldest && oldest.key) keysToRemove.push(oldest.key);
  }
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }

  try {
    await chrome.storage.local.set({
      [cacheKey]: data,
      [CACHE_INDEX_KEY]: index
    });
  } catch (_) {
    // 若超出 storage 配额（含 WebP 贴片时），清理较旧一半缓存后重试一次
    const half = Math.ceil(index.length / 2);
    const evict = index.splice(0, half).map((x) => x.key).filter(Boolean);
    if (evict.length > 0) await chrome.storage.local.remove(evict);
    try {
      await chrome.storage.local.set({ [cacheKey]: data, [CACHE_INDEX_KEY]: index });
    } catch (_) {
      // 忽略单条过大无法缓存的情况（VPS 端已有 SQLite 持久化缓存）
    }
  }
}

async function getCacheStats() {
  const indexRes = await chrome.storage.local.get(CACHE_INDEX_KEY);
  const index = Array.isArray(indexRes[CACHE_INDEX_KEY]) ? indexRes[CACHE_INDEX_KEY] : [];
  return { count: index.length, max: MAX_CACHE_ITEMS };
}

async function clearAllCache() {
  const indexRes = await chrome.storage.local.get(CACHE_INDEX_KEY);
  const index = Array.isArray(indexRes[CACHE_INDEX_KEY]) ? indexRes[CACHE_INDEX_KEY] : [];
  const keys = index.map((i) => i.key).filter(Boolean);
  keys.push(CACHE_INDEX_KEY);
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  return { cleared: index.length };
}

// -------------------- DNR 动态注入 Referer + Cookie 防盗链抓图 --------------------

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

async function getCookieHeaderForUrl(url) {
  if (!chrome.cookies || !chrome.cookies.getAll) return '';
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!Array.isArray(cookies) || cookies.length === 0) return '';
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    return '';
  }
}

async function withSessionHeaderRule(targetUrl, referer, cookieHeader, fn) {
  const requestHeaders = [];
  if (referer) {
    // 严格仅设置 Referer 和 Cookie（避免对 GET 图片请求强行加 Origin 触发防盗链 CDN 403）
    requestHeaders.push({ header: 'referer', operation: 'set', value: referer });
  }
  if (cookieHeader) {
    requestHeaders.push({ header: 'cookie', operation: 'set', value: cookieHeader });
  }

  if (
    requestHeaders.length === 0 ||
    !chrome.declarativeNetRequest ||
    !chrome.declarativeNetRequest.updateSessionRules
  ) {
    return fn();
  }

  const ruleId = Math.floor(Math.random() * 1900000000) + 1;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders
          },
          condition: {
            urlFilter: `|${targetUrl}|`,
            resourceTypes: ['xmlhttprequest', 'other'],
            tabIds: [chrome.tabs.TAB_ID_NONE]
          }
        }
      ]
    });
    return await fn();
  } finally {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    } catch (_) {}
  }
}

async function fetchImageAsPage(url, sender) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('不支持的图片地址格式');
  }

  const referer = (sender && (sender.url || (sender.tab && sender.tab.url))) || '';
  const cookieHeader = await getCookieHeaderForUrl(url);

  const response = await withSessionHeaderRule(url, referer, cookieHeader, async () => {
    try {
      return await fetch(url, { credentials: 'include' });
    } catch (_) {
      return await fetch(url, { credentials: 'omit' });
    }
  });

  if (!response.ok) {
    throw new Error(`防盗链抓图失败 (HTTP ${response.status})`);
  }

  const contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('抓取到的图片内容为空');
  }
  const base64 = arrayBufferToBase64(buffer);
  const mime = contentType.startsWith('image/') ? contentType : 'image/jpeg';
  return `data:${mime};base64,${base64}`;
}

// -------------------- 通用工具 --------------------

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('无效的图片 Base64 数据');
  return { mimeType: match[1], base64: match[2] };
}

function dataUrlToBlob(dataUrl) {
  const { mimeType, base64 } = parseDataUrl(dataUrl);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatApiError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.detail || parsed?.error?.message || parsed?.message || '';
  } catch (_) {
    detail = (bodyText || '').slice(0, 180);
  }
  if (status === 401 || status === 403) {
    return `认证失败或无权限 (HTTP ${status})${detail ? ': ' + detail : ''}`;
  }
  if (status === 429) {
    return `请求过于频繁或额度不足 (HTTP 429)${detail ? ': ' + detail : ''}`;
  }
  if (status === 404) {
    return `接口地址或模型不存在 (HTTP 404)${detail ? ': ' + detail : ''}`;
  }
  return `接口请求失败 (HTTP ${status})${detail ? ': ' + detail : ''}`;
}

// -------------------- 引擎 1：自建 VPS 无痕擦字后端 --------------------

async function callVpsTranslate(dataUrl, settings, force, pageMeta) {
  const baseUrl = (settings.vpsBaseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(baseUrl)) {
    throw new Error('请先在插件配置中填写 VPS 后端地址（如 http://你的IP:8765）');
  }

  const blob = dataUrlToBlob(dataUrl);
  const form = new FormData();
  form.append('file', blob, 'comic.jpg');
  if (settings.customPrompt) {
    form.append('custom_prompt', settings.customPrompt.trim());
  }
  if (pageMeta && pageMeta.pageTitle) {
    form.append('page_title', String(pageMeta.pageTitle).slice(0, 200));
  }
  if (pageMeta && pageMeta.pageUrl) {
    form.append('page_url', String(pageMeta.pageUrl).slice(0, 400));
  }
  form.append('force', force ? 'true' : 'false');

  const headers = {};
  if ((settings.vpsApiToken || '').trim()) {
    headers['Authorization'] = `Bearer ${settings.vpsApiToken.trim()}`;
  }

  const resp = await fetch(`${baseUrl}/api/v1/translate`, {
    method: 'POST',
    headers,
    body: form
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(formatApiError(resp.status, text));
  }

  const data = JSON.parse(text);
  const imgW = Number(data.imgWidth) || 1000;
  const imgH = Number(data.imgHeight) || 1000;
  const rawBubbles = Array.isArray(data.bubbles) ? data.bubbles : [];

  const norm = (v) => Number(clamp(v, 0, 1000).toFixed(3));
  return rawBubbles
    .filter((b) => b && (b.translation || b.original))
    .map((b, idx) => {
      // 保留 3 位小数高精度比例，万像素超长条漫纵向对齐误差 < 0.05px
      const x1 = norm((Number(b.x) / imgW) * 1000);
      const y1 = norm((Number(b.y) / imgH) * 1000);
      const x2 = norm(((Number(b.x) + Number(b.width)) / imgW) * 1000);
      const y2 = norm(((Number(b.y) + Number(b.height)) / imgH) * 1000);
      const tx1 = b.textX !== undefined ? norm((Number(b.textX) / imgW) * 1000) : x1;
      const ty1 = b.textY !== undefined ? norm((Number(b.textY) / imgH) * 1000) : y1;
      const tx2 = b.textWidth !== undefined ? norm(((Number(b.textX) + Number(b.textWidth)) / imgW) * 1000) : x2;
      const ty2 = b.textHeight !== undefined ? norm(((Number(b.textY) + Number(b.textHeight)) / imgH) * 1000) : y2;
      return {
        key: b.key || `vps-${idx}-${Math.round(x1)}-${Math.round(y1)}`,
        x1,
        y1,
        x2,
        y2,
        tx1,
        ty1,
        tx2,
        ty2,
        origFontRatio: Number(b.origFontRatio) || 0,
        isUniformBg: b.isUniformBg !== false,
        original: String(b.original || '').trim(),
        translation: String(b.translation || b.original || '').trim(),
        type: b.type || 'speech',
        shape: b.shape === 'rect' ? 'rect' : 'ellipse',
        bgColor: (b.colors && b.colors.background) || '#FFFFFF',
        textColor: (b.colors && b.colors.text) || '#141414',
        inpaintingDataUrl: b.inpaintingDataUrl || ''
      };
    });
}

// -------------------- 引擎 2 & 3：直连多模态大模型 (Gemini / OpenAI) --------------------

function buildPrompt(settings, isGemini) {
  const sfxRule = settings.translateSfx
    ? '- Also include prominent sound effects (SFX) with type "sfx".'
    : '- Ignore pure sound effects (SFX), logos, watermarks, and page numbers.';
  const boxSpec = isGemini
    ? '- "box_2d": [ymin, xmin, ymax, xmax] integers in 0..1000 tightly enclosing the TEXT REGION inside each bubble.'
    : '- "xmin", "ymin", "xmax", "ymax": integers in 0..1000 tightly enclosing the TEXT REGION inside each bubble.';
  const extra = (settings.customPrompt || '').trim()
    ? `\nAdditional translation preferences:\n${settings.customPrompt.trim()}\n`
    : '';

  return `You are a professional English-to-Simplified-Chinese comic book translator and layout detector.
Detect ALL English speech bubbles, thought bubbles, and narration/caption boxes.
Rules:
1. Group all lines belonging to the SAME bubble into ONE item.
2. ${boxSpec}
3. Translate "original" English into natural, colloquial Simplified Chinese ("translation").
4. Skip non-English bubbles. ${sfxRule}
5. Return ONLY valid JSON: {"bubbles": [...]} with fields original, translation, type, shape, bg_color, text_color.${extra}`;
}

function buildGeminiSchema() {
  return {
    type: 'OBJECT',
    properties: {
      bubbles: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
            original: { type: 'STRING' },
            translation: { type: 'STRING' },
            type: { type: 'STRING' },
            shape: { type: 'STRING' },
            bg_color: { type: 'STRING' },
            text_color: { type: 'STRING' }
          },
          required: ['box_2d', 'original', 'translation']
        }
      }
    },
    required: ['bubbles']
  };
}

function extractJsonText(rawText) {
  if (!rawText || typeof rawText !== 'string') throw new Error('模型返回内容为空');
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const firstObj = text.indexOf('{');
    const lastObj = text.lastIndexOf('}');
    if (firstObj !== -1 && lastObj > firstObj) return JSON.parse(text.slice(firstObj, lastObj + 1));
    const firstArr = text.indexOf('[');
    const lastArr = text.lastIndexOf(']');
    if (firstArr !== -1 && lastArr > firstArr) return JSON.parse(text.slice(firstArr, lastArr + 1));
    throw new Error('模型返回的不是合法 JSON 格式');
  }
}

function sanitizeColor(color, fallback) {
  if (typeof color === 'string' && /^(#[0-9a-fA-F]{3,6}|rgb\([^)]+\))$/.test(color.trim())) {
    return color.trim();
  }
  return fallback;
}

function normalizeBubbles(parsed, imgWidth, imgHeight, isGemini) {
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.bubbles)
      ? parsed.bubbles
      : [];
  const result = [];
  for (let idx = 0; idx < rawList.length; idx++) {
    const item = rawList[idx];
    if (!item || typeof item !== 'object') continue;
    const translation = String(item.translation || item.zh || '').trim();
    const original = String(item.original || item.en || '').trim();
    if (!translation) continue;

    let x1, y1, x2, y2;
    if (Array.isArray(item.box_2d) && item.box_2d.length === 4) {
      [y1, x1, y2, x2] = item.box_2d.map(Number);
    } else if (item.xmin !== undefined && item.ymin !== undefined && item.xmax !== undefined && item.ymax !== undefined) {
      x1 = Number(item.xmin); y1 = Number(item.ymin); x2 = Number(item.xmax); y2 = Number(item.ymax);
    } else if (item.x1 !== undefined && item.y1 !== undefined && item.x2 !== undefined && item.y2 !== undefined) {
      x1 = Number(item.x1); y1 = Number(item.y1); x2 = Number(item.x2); y2 = Number(item.y2);
    } else if (item.x !== undefined && item.y !== undefined && item.width !== undefined && item.height !== undefined) {
      x1 = Number(item.x); y1 = Number(item.y); x2 = x1 + Number(item.width); y2 = y1 + Number(item.height);
    } else {
      continue;
    }

    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const maxVal = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2));
    if (maxVal <= 1.05) {
      x1 *= 1000; y1 *= 1000; x2 *= 1000; y2 *= 1000;
    } else if (maxVal > 1000 && imgWidth > 0 && imgHeight > 0) {
      x1 = (x1 / imgWidth) * 1000; x2 = (x2 / imgWidth) * 1000;
      y1 = (y1 / imgHeight) * 1000; y2 = (y2 / imgHeight) * 1000;
    }

    const nx1 = clamp(Math.min(x1, x2), 0, 1000);
    const ny1 = clamp(Math.min(y1, y2), 0, 1000);
    const nx2 = clamp(Math.max(x1, x2), 0, 1000);
    const ny2 = clamp(Math.max(y1, y2), 0, 1000);
    if (nx2 - nx1 < 10 || ny2 - ny1 < 8) continue;
    if (nx2 - nx1 > 960 && ny2 - ny1 > 960) continue;

    result.push({
      key: `vlm-${idx}-${Math.round(nx1)}-${Math.round(ny1)}`,
      x1: Math.round(nx1),
      y1: Math.round(ny1),
      x2: Math.round(nx2),
      y2: Math.round(ny2),
      original,
      translation,
      type: ['speech', 'thought', 'narration', 'sfx'].includes(item.type) ? item.type : 'speech',
      shape: item.shape === 'rect' || item.type === 'narration' ? 'rect' : 'ellipse',
      bgColor: sanitizeColor(item.bg_color, '#FFFFFF'),
      textColor: sanitizeColor(item.text_color, '#141414'),
      inpaintingDataUrl: ''
    });
  }
  return result;
}

async function callGeminiVision(dataUrl, width, height, settings) {
  const apiKey = (settings.geminiApiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 Gemini API Key');
  const baseUrl = (settings.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta').trim().replace(/\/+$/, '');
  const model = (settings.geminiModel || 'gemini-2.5-flash').trim();
  const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const { mimeType, base64 } = parseDataUrl(dataUrl);

  const payload = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(settings, true) }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: buildGeminiSchema() }
  };

  let resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (resp.status === 400) {
    const errText = await resp.text();
    if (/responseSchema|response_schema/i.test(errText)) {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: payload.contents, generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
      });
    } else {
      throw new Error(formatApiError(resp.status, errText));
    }
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(formatApiError(resp.status, text));
  const data = JSON.parse(text);
  const rawText = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return normalizeBubbles(extractJsonText(rawText), width, height, true);
}

async function callOpenAIVision(dataUrl, width, height, settings) {
  const baseUrl = (settings.openaiBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const apiKey = (settings.openaiApiKey || '').trim();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseUrl);
  if (!apiKey && !isLocal) throw new Error('请先填写 OpenAI 兼容 API Key');
  const model = (settings.openaiModel || 'gpt-4o-mini').trim();
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const baseBody = {
    model,
    temperature: 0.2,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(settings, false) }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }]
  };

  let resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(Object.assign({ response_format: { type: 'json_object' } }, baseBody)) });
  if (resp.status === 400) {
    const errText = await resp.text();
    if (/response_format|json_object/i.test(errText)) {
      resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(baseBody) });
    } else {
      throw new Error(formatApiError(resp.status, errText));
    }
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(formatApiError(resp.status, text));
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  const rawText = Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content || '');
  return normalizeBubbles(extractJsonText(rawText), width, height, false);
}

// -------------------- 连通性测试 --------------------

async function testApiConnection(overrideSettings) {
  const settings = globalThis.ComicBubbleConfig.mergeSettings(
    Object.assign({}, await globalThis.ComicBubbleConfig.loadSettings(), overrideSettings || {})
  );

  if (settings.provider === 'vps') {
    const baseUrl = (settings.vpsBaseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/i.test(baseUrl)) throw new Error('请填写 VPS 后端地址（如 http://你的IP:8765）');
    const headers = {};
    if ((settings.vpsApiToken || '').trim()) {
      headers['Authorization'] = `Bearer ${settings.vpsApiToken.trim()}`;
    }
    const resp = await fetch(`${baseUrl}/health`, { headers });
    const text = await resp.text();
    if (!resp.ok) throw new Error(formatApiError(resp.status, text));
    const info = JSON.parse(text);
    const cacheCount = info?.cache?.count ?? 0;
    return {
      ok: true,
      message: `VPS 连接成功！引擎: ${info.detector || 'OCR'} · 擦字: ${info.inpainter || 'telea'} · 翻译: ${info.translator || 'auto'} · 服务端缓存: ${cacheCount} 张`
    };
  }

  if (settings.provider === 'gemini') {
    const apiKey = (settings.geminiApiKey || '').trim();
    if (!apiKey) throw new Error('请填写 Gemini API Key');
    const baseUrl = (settings.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta').trim().replace(/\/+$/, '');
    const model = (settings.geminiModel || 'gemini-2.5-flash').trim();
    const resp = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }], generationConfig: { maxOutputTokens: 8 } })
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(formatApiError(resp.status, text));
    return { ok: true, message: `Gemini (${model}) 连接成功！` };
  }

  const baseUrl = (settings.openaiBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const apiKey = (settings.openaiApiKey || '').trim();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseUrl);
  if (!apiKey && !isLocal) throw new Error('请填写 API Key');
  const model = (settings.openaiModel || 'gpt-4o-mini').trim();
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply OK' }] })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(formatApiError(resp.status, text));
  return { ok: true, message: `OpenAI 兼容接口 (${model}) 连接成功！` };
}

// -------------------- 消息路由 --------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  (async () => {
    switch (message.type) {
      case 'FETCH_IMAGE':
      case 'FETCH_AS_PAGE': {
        const dataUrl = await fetchImageAsPage(message.url, sender);
        sendResponse({ ok: true, dataUrl });
        break;
      }

      case 'TAKE_SCREENSHOT': {
        const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        sendResponse({ ok: true, dataUrl });
        break;
      }

      case 'GET_CACHED_TRANSLATION': {
        const settings = await globalThis.ComicBubbleConfig.loadSettings();
        if (!settings.enableCache || !message.imageKey) {
          sendResponse({ ok: true, hit: false });
          return;
        }
        const cacheKey = buildCacheKey(message.imageKey, settings);
        const cached = await getCache(cacheKey);
        sendResponse({ ok: true, hit: Boolean(cached), bubbles: cached ? cached.bubbles : null });
        break;
      }

      case 'SAVE_CACHED_TRANSLATION': {
        const settings = await globalThis.ComicBubbleConfig.loadSettings();
        if (!settings.enableCache || !message.imageKey) {
          sendResponse({ ok: true });
          return;
        }
        const cacheKey = buildCacheKey(message.imageKey, settings);
        await setCache(cacheKey, { bubbles: Array.isArray(message.bubbles) ? message.bubbles : [], ts: Date.now() });
        sendResponse({ ok: true });
        break;
      }

      case 'TRANSLATE_VPS_IMAGE': {
        const settings = await globalThis.ComicBubbleConfig.loadSettings();
        const pageMeta = {
          pageTitle: message.pageTitle || (sender && sender.tab && sender.tab.title) || '',
          pageUrl: message.pageUrl || (sender && (sender.url || (sender.tab && sender.tab.url))) || ''
        };
        const bubbles = await callVpsTranslate(message.dataUrl, settings, Boolean(message.force), pageMeta);
        sendResponse({ ok: true, bubbles });
        break;
      }

      case 'TRANSLATE_IMAGE_TILE': {
        const settings = await globalThis.ComicBubbleConfig.loadSettings();
        const bubbles =
          settings.provider === 'gemini'
            ? await callGeminiVision(message.dataUrl, message.width, message.height, settings)
            : await callOpenAIVision(message.dataUrl, message.width, message.height, settings);
        sendResponse({ ok: true, bubbles });
        break;
      }

      case 'TEST_API': {
        const res = await testApiConnection(message.settings);
        sendResponse(res);
        break;
      }

      case 'CACHE_STATS': {
        const stats = await getCacheStats();
        sendResponse({ ok: true, stats });
        break;
      }

      case 'CLEAR_CACHE': {
        const res = await clearAllCache();
        sendResponse({ ok: true, cleared: res.cleared });
        break;
      }

      default:
        sendResponse({ ok: false, error: '未知消息类型' });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  });

  return true;
});
