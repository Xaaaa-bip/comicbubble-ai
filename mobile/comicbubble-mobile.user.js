// ==UserScript==
// @name         ComicBubble AI - Android 手机漫画气泡无痕翻译
// @namespace    https://comicbubble.local/
// @version      5.0.0
// @description  专为 Android 手机浏览器（狐猴/Via/X浏览器/Firefox+Tampermonkey）打造：直连自建 VPS 无痕透明擦字、原字号自适应、条漫视口优先+整话后台预翻、触屏悬浮球与点按原文对照。
// @match        *://*/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.challenges.cloudflare.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_CFG = {
    vpsBaseUrl: 'http://your-vps-ip:8765',
    vpsApiToken: '',
    autoTranslate: true,
    maxConcurrency: 3,
    blacklist: ['baidu.com', 'bing.com', 'google.com', 'github.com', 'bilibili.com', 'zhihu.com', 'taobao.com', 'jd.com', 'youtube.com']
  };

  function loadCfg() {
    try {
      const saved = typeof GM_getValue === 'function' ? GM_getValue('cb_mobile_cfg', null) : null;
      return Object.assign({}, DEFAULT_CFG, saved || {});
    } catch (_) {
      return Object.assign({}, DEFAULT_CFG);
    }
  }

  function saveCfg(next) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue('cb_mobile_cfg', next);
    } catch (_) {}
  }

  const state = {
    cfg: loadCfg(),
    overlayVisible: true,
    activeRequests: 0,
    records: new Map(),
    layoutRaf: null,
    fabEl: null,
    sheetEl: null,
    progEl: null,
    progHideTimer: null,
    fullChapterMode: false,
    fullChapterForce: false,
    fullChapterTimer: null,
    toastEl: null,
    toastTimer: null
  };

  function normHost(h) {
    return String(h || '').toLowerCase().replace(/^www\./, '');
  }

  function isSiteEnabled() {
    if (!state.cfg.autoTranslate) return false;
    const host = normHost(location.hostname);
    return !(state.cfg.blacklist || []).some((d) => host === normHost(d) || host.endsWith('.' + normHost(d)));
  }

  // -------------------- 样式注入 --------------------

  const STYLE_TEXT = `
.cbm-layer{position:absolute!important;pointer-events:none!important;overflow:visible!important;isolation:isolate!important;z-index:9999!important;box-sizing:border-box!important;font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif!important}
.cbm-layer *{box-sizing:border-box!important}
.cbm-bubbles{position:absolute!important;inset:0!important;pointer-events:none!important;overflow:hidden!important}
.cbm-bubbles.cbm-overflow{overflow:visible!important}
.cbm-bubbles.cbm-hidden{opacity:0!important;visibility:hidden!important}
.cbm-patch{position:absolute!important;pointer-events:none!important;background-repeat:no-repeat!important;background-size:100% 100%!important;z-index:1!important}
.cbm-bubble{position:absolute!important;display:flex!important;align-items:center!important;justify-content:center!important;text-align:center!important;padding:1px 2px!important;pointer-events:auto!important;background:transparent!important;z-index:2!important;word-break:break-word!important}
.cbm-text{display:block!important;width:100%!important;line-height:1.16!important;white-space:pre-wrap!important;font-weight:600!important}
#cbm-fab{position:fixed!important;right:14px!important;bottom:76px!important;z-index:2147483644!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;gap:8px!important;touch-action:none!important;user-select:none!important;font-family:"Microsoft YaHei","PingFang SC",sans-serif!important}
.cbm-ball{width:46px!important;height:46px!important;border-radius:50%!important;border:2px solid rgba(255,255,255,.3)!important;background:linear-gradient(135deg,rgba(56,189,248,.92),rgba(79,70,229,.95))!important;color:#fff!important;font-size:17px!important;font-weight:800!important;display:flex!important;align-items:center!important;justify-content:center!important;box-shadow:0 6px 18px rgba(0,0,0,.35)!important;opacity:.8!important;padding:0!important}
.cbm-menu{display:none!important;flex-direction:column!important;gap:6px!important;padding:8px!important;border-radius:14px!important;background:rgba(15,23,42,.94)!important;border:1px solid rgba(255,255,255,.15)!important;min-width:130px!important;box-shadow:0 10px 26px rgba(0,0,0,.4)!important}
.cbm-menu.cbm-open{display:flex!important}
.cbm-mbtn{border:none!important;background:rgba(255,255,255,.12)!important;color:#f8fafc!important;font-size:13px!important;font-weight:600!important;padding:9px 12px!important;border-radius:9px!important;text-align:center!important}
#cbm-sheet{position:fixed!important;left:10px!important;right:10px!important;bottom:12px!important;z-index:2147483647!important;background:rgba(15,23,42,.96)!important;color:#f8fafc!important;border-radius:16px!important;border:1px solid rgba(255,255,255,.15)!important;box-shadow:0 12px 32px rgba(0,0,0,.45)!important;padding:14px!important;display:none!important;font-family:"Microsoft YaHei","PingFang SC",sans-serif!important}
#cbm-sheet.cbm-open{display:block!important}
.cbm-slabel{font-size:11px!important;color:#93c5fd!important;font-weight:700!important;margin-bottom:4px!important}
.cbm-sorig{font-size:13px!important;color:#e2e8f0!important;line-height:1.45!important;margin-bottom:10px!important;max-height:90px!important;overflow-y:auto!important}
.cbm-sinput{width:100%!important;min-height:52px!important;border-radius:10px!important;border:1px solid rgba(148,163,184,.4)!important;background:#1e293b!important;color:#fff!important;font-size:14px!important;padding:8px 10px!important;margin-bottom:10px!important;box-sizing:border-box!important}
.cbm-sacts{display:flex!important;gap:8px!important;justify-content:flex-end!important}
.cbm-sbtn{border:none!important;border-radius:9px!important;padding:8px 14px!important;font-size:13px!important;font-weight:600!important;background:rgba(255,255,255,.15)!important;color:#fff!important}
.cbm-sbtn.cbm-pri{background:#4f46e5!important}
#cbm-toast{position:fixed!important;left:50%!important;bottom:132px!important;transform:translateX(-50%)!important;background:rgba(15,23,42,.92)!important;color:#fff!important;padding:8px 14px!important;border-radius:999px!important;font-size:12px!important;z-index:2147483646!important;pointer-events:none!important;opacity:0!important;transition:opacity .2s!important;max-width:85vw!important;text-align:center!important}
#cbm-toast.cbm-show{opacity:1!important}
#cbm-prog{position:fixed!important;left:50%!important;bottom:16px!important;transform:translateX(-50%)!important;width:min(360px,calc(100vw - 24px))!important;padding:10px 12px!important;border-radius:14px!important;background:rgba(15,23,42,.95)!important;color:#f8fafc!important;border:1px solid rgba(255,255,255,.15)!important;box-shadow:0 10px 26px rgba(0,0,0,.4)!important;z-index:2147483645!important;display:none!important;font-family:"Microsoft YaHei","PingFang SC",sans-serif!important}
#cbm-prog.cbm-show{display:block!important}
.cbm-ptop{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important;margin-bottom:6px!important;font-size:12px!important;font-weight:600!important}
.cbm-pstop{border:none!important;background:rgba(248,113,113,.24)!important;color:#fecaca!important;font-size:11px!important;font-weight:600!important;padding:3px 9px!important;border-radius:999px!important}
.cbm-ptrack{width:100%!important;height:6px!important;border-radius:999px!important;background:rgba(255,255,255,.15)!important;overflow:hidden!important}
.cbm-pfill{height:100%!important;width:0%!important;border-radius:999px!important;background:linear-gradient(90deg,#38bdf8,#6366f1,#4ade80)!important;transition:width .25s ease!important}
`;

  function injectStyles() {
    if (document.getElementById('cbm-style')) return;
    const s = document.createElement('style');
    s.id = 'cbm-style';
    s.textContent = STYLE_TEXT;
    document.head.appendChild(s);
  }

  function showToast(msg, ms = 2200) {
    if (!state.toastEl) {
      const t = document.createElement('div');
      t.id = 'cbm-toast';
      document.documentElement.appendChild(t);
      state.toastEl = t;
    }
    state.toastEl.textContent = msg;
    state.toastEl.classList.add('cbm-show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => state.toastEl.classList.remove('cbm-show'), ms);
  }

  // -------------------- GM_xmlhttpRequest 跨域抓图 & 请求 VPS --------------------

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest(
        Object.assign({}, opts, {
          onload: (res) => resolve(res),
          onerror: (err) => reject(new Error(err?.error || '网络请求失败')),
          ontimeout: () => reject(new Error('请求超时'))
        })
      );
    });
  }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败'));
      im.src = src;
    });
  }

  async function acquireDrawable(imgEl) {
    const src = imgEl.currentSrc || imgEl.src;
    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;
    try {
      const c = document.createElement('canvas');
      c.width = 2; c.height = 2;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgEl, 0, 0, 2, 2);
      ctx.getImageData(0, 0, 1, 1);
      return { drawable: imgEl, width: w, height: h };
    } catch (_) {}

    const res = await gmRequest({
      method: 'GET',
      url: src,
      responseType: 'blob',
      anonymous: false,
      headers: { Referer: location.href }
    });
    if (res.status < 200 || res.status >= 300 || !res.response) {
      throw new Error(`抓图失败 HTTP ${res.status}`);
    }
    const objUrl = URL.createObjectURL(res.response);
    try {
      const clean = await loadImg(objUrl);
      return { drawable: clean, width: clean.naturalWidth || w, height: clean.naturalHeight || h };
    } finally {
      setTimeout(() => URL.revokeObjectURL(objUrl), 15000);
    }
  }

  async function callVps(dataUrl, force = false) {
    const base = (state.cfg.vpsBaseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('未设置 VPS 地址');
    const headers = { 'Content-Type': 'application/json' };
    if (state.cfg.vpsApiToken) headers['Authorization'] = `Bearer ${state.cfg.vpsApiToken}`;

    const res = await gmRequest({
      method: 'POST',
      url: `${base}/api/v1/translate-json`,
      headers,
      timeout: 35000,
      data: JSON.stringify({ image_base64: dataUrl, force: Boolean(force) })
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`VPS HTTP ${res.status}`);
    }
    const data = JSON.parse(res.responseText);
    const imgW = Number(data.imgWidth) || 1000;
    const imgH = Number(data.imgHeight) || 1000;
    const clamp = (v) => Number(Math.max(0, Math.min(1000, v)).toFixed(3));
    return (data.bubbles || []).map((b, idx) => {
      const x1 = clamp((b.x / imgW) * 1000), y1 = clamp((b.y / imgH) * 1000);
      const x2 = clamp(((b.x + b.width) / imgW) * 1000), y2 = clamp(((b.y + b.height) / imgH) * 1000);
      const tx1 = b.textX !== undefined ? clamp((b.textX / imgW) * 1000) : x1;
      const ty1 = b.textY !== undefined ? clamp((b.textY / imgH) * 1000) : y1;
      const tx2 = b.textWidth !== undefined ? clamp(((b.textX + b.textWidth) / imgW) * 1000) : x2;
      const ty2 = b.textHeight !== undefined ? clamp(((b.textY + b.textHeight) / imgH) * 1000) : y2;
      return {
        key: b.key || `m-${idx}`,
        x1, y1, x2, y2, tx1, ty1, tx2, ty2,
        origFontRatio: Number(b.origFontRatio) || 0,
        isUniformBg: b.isUniformBg !== false,
        original: b.original || '',
        translation: b.translation || b.original || '',
        bgColor: b.colors?.background || '#FFFFFF',
        textColor: b.colors?.text || '#141414',
        inpaintingDataUrl: b.inpaintingDataUrl || ''
      };
    });
  }

  // -------------------- 长图虚拟分片与合并 --------------------

  function planTiles(w, h) {
    const idealH = Math.max(1450, Math.round(w * 2.15));
    const overlap = Math.round(idealH * 0.14);
    const step = Math.max(500, idealH - overlap);
    const tiles = [];
    for (let y = 0; y < h && tiles.length < 30; y += step) {
      let sliceH = Math.min(idealH, h - y);
      if (h - (y + sliceH) < 320) sliceH = h - y;
      const isBottomEdge = y + sliceH >= h;
      tiles.push({ index: tiles.length, offsetY: y, sliceH, fullHeight: h, isTopEdge: y === 0, isBottomEdge });
      if (isBottomEdge) break;
    }
    return tiles;
  }

  function encodeTile(drawable, w, offsetY, sliceH) {
    const scale = w > 1024 ? 1024 / w : 1;
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(sliceH * scale));
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(drawable, 0, offsetY, w, sliceH, 0, 0, tw, th);
    return c.toDataURL('image/jpeg', 0.84);
  }

  function mergeTileBubbles(existing, tile, incomingRaw) {
    const mapY = (v) => Number((((tile.offsetY + (v / 1000) * tile.sliceH) / tile.fullHeight) * 1000).toFixed(3));
    const fontScale = tile.sliceH / Math.max(1, tile.fullHeight);
    const incoming = incomingRaw.map((b) => {
      let s = 1000;
      if (!tile.isTopEdge) s = Math.min(s, b.y1);
      if (!tile.isBottomEdge) s = Math.min(s, 1000 - b.y2);
      return Object.assign({}, b, {
        y1: Math.max(0, Math.min(1000, mapY(b.y1))),
        y2: Math.max(0, Math.min(1000, mapY(b.y2))),
        ty1: Math.max(0, Math.min(1000, mapY(b.ty1))),
        ty2: Math.max(0, Math.min(1000, mapY(b.ty2))),
        origFontRatio: b.origFontRatio ? Number((b.origFontRatio * fontScale).toFixed(6)) : 0,
        _s: s
      });
    });
    const all = [...existing, ...incoming].sort((a, b) => (b._s ?? 500) - (a._s ?? 500));
    const kept = [];
    for (const c of all) {
      let dup = false;
      for (const ex of kept) {
        const inter = Math.max(0, Math.min(c.x2, ex.x2) - Math.max(c.x1, ex.x1)) * Math.max(0, Math.min(c.y2, ex.y2) - Math.max(c.y1, ex.y1));
        if (inter <= 0) continue;
        const a1 = Math.max(0.01, (c.x2 - c.x1) * (c.y2 - c.y1));
        const a2 = Math.max(0.01, (ex.x2 - ex.x1) * (ex.y2 - ex.y1));
        if (inter / (a1 + a2 - inter) > 0.28 || inter / Math.min(a1, a2) > 0.58) { dup = true; break; }
      }
      if (!dup) kept.push(c);
    }
    return kept;
  }

  // -------------------- 漫画筛选、挂载与排版 --------------------

  function isCandidateImg(img) {
    if (!(img instanceof HTMLImageElement) || !img.isConnected || !img.complete) return false;
    const src = img.currentSrc || img.src || '';
    if (!src || /\.svg(\?|$)|\.gif(\?|$)/i.test(src)) return false;
    const vw = window.innerWidth || 390;
    const r = img.getBoundingClientRect();
    const webtoonHint = /wp-manga-chapter-img|chapter|webtoon|manga/i.test(img.className) || Boolean(img.closest('.reading-content,.page-break,.chapter-content'));
    const minW = Math.min(240, Math.round(vw * 0.52));
    const minH = webtoonHint || r.width >= vw * 0.6 ? 75 : 150;
    return r.width >= minW && r.height >= minH && img.naturalWidth >= 240 && img.naturalHeight >= minH && r.width / r.height <= 7.5;
  }

  function getOrCreateRec(img) {
    let rec = state.records.get(img);
    if (rec) return rec;
    injectStyles();
    const layer = document.createElement('span');
    layer.className = 'cbm-layer';
    const bubblesEl = document.createElement('div');
    bubblesEl.className = 'cbm-bubbles';
    if (!state.overlayVisible) bubblesEl.classList.add('cbm-hidden');
    layer.appendChild(bubblesEl);

    let p = img.parentElement;
    while (p && p !== document.body && getComputedStyle(p).display === 'inline') p = p.parentElement;
    if (p && getComputedStyle(p).position === 'static') p.style.position = 'relative';
    const anchor = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : img;
    anchor.insertAdjacentElement('afterend', layer);

    rec = { img, status: 'idle', bubbles: [], stripState: null, lastSize: '', layer, bubblesEl };
    state.records.set(img, rec);
    ensureFab();
    syncPos(rec);
    return rec;
  }

  function fitFont(textEl, bubble, w, h, containerH) {
    const raw = String(bubble.translation || '').trim();
    const cands = [raw];
    const s1 = raw.replace(/([。！？…])(?=[^\s”」』】）》])/g, '$1\n');
    if (s1 !== raw) cands.push(s1);
    if (raw.length >= 14) {
      const s2 = raw.replace(/([，、；。！？…])(?=[^\s”」』】）》])/g, '$1\n');
      if (s2 !== raw && s2 !== s1) cands.push(s2);
    }
    const minPx = 9;
    const maxPx = bubble.origFontRatio > 0 && containerH > 0
      ? Math.max(11, Math.min(32, Math.round(bubble.origFontRatio * containerH * 1.4)))
      : Math.max(11, Math.min(26, Math.floor(Math.min(w, h) * 0.55)));
    let best = minPx, bestTxt = cands[0], okAny = false;
    for (const c of cands) {
      textEl.textContent = c;
      let lo = minPx, hi = maxPx, fit = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        textEl.style.fontSize = `${mid}px`;
        if (textEl.scrollHeight <= h + 2 && textEl.scrollWidth <= w + 3) { fit = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (fit !== null && (!okAny || fit > best)) { okAny = true; best = fit; bestTxt = c; }
    }
    textEl.textContent = bestTxt;
    textEl.style.fontSize = `${best}px`;
  }

  function syncPos(rec) {
    if (!rec.img.isConnected) { rec.layer.remove(); state.records.delete(rec.img); return; }
    const box = rec.img.getBoundingClientRect();
    if (box.width < 30 || box.height < 30) return;
    const op = rec.layer.offsetParent || document.documentElement;
    const pr = op.getBoundingClientRect();
    const ps = getComputedStyle(op);
    rec.layer.style.left = `${(box.left - pr.left - (parseFloat(ps.borderLeftWidth) || 0) + (op === document.documentElement ? 0 : op.scrollLeft)).toFixed(1)}px`;
    rec.layer.style.top = `${(box.top - pr.top - (parseFloat(ps.borderTopWidth) || 0) + (op === document.documentElement ? 0 : op.scrollTop)).toFixed(1)}px`;
    rec.layer.style.width = `${box.width.toFixed(1)}px`;
    rec.layer.style.height = `${box.height.toFixed(1)}px`;

    const key = `${Math.round(box.width)}x${Math.round(box.height)}_${rec.bubbles.length}`;
    if (rec.bubbles.length > 0 && rec.lastSize !== key) {
      rec.lastSize = key;
      rec.bubblesEl.querySelectorAll('.cbm-bubble').forEach((node, idx) => {
        const b = rec.bubbles[idx];
        const t = node.querySelector('.cbm-text');
        if (!b || !t) return;
        const bw = Math.max(16, ((b.tx2 - b.tx1) / 1000) * box.width);
        const bh = Math.max(14, ((b.ty2 - b.ty1) / 1000) * box.height);
        fitFont(t, b, bw - 2, bh - 2, box.height);
      });
    }
  }

  function renderRec(rec) {
    rec.bubblesEl.textContent = '';
    rec.bubbles.forEach((b, idx) => {
      if (b.inpaintingDataUrl) {
        const p = document.createElement('div');
        p.className = 'cbm-patch';
        p.style.left = `${b.x1 / 10}%`;
        p.style.top = `${b.y1 / 10}%`;
        p.style.width = `${(b.x2 - b.x1) / 10}%`;
        p.style.height = `${(b.y2 - b.y1) / 10}%`;
        p.style.backgroundImage = `url(${b.inpaintingDataUrl})`;
        rec.bubblesEl.appendChild(p);
      }
      const el = document.createElement('div');
      el.className = 'cbm-bubble';
      el.style.left = `${b.tx1 / 10}%`;
      el.style.top = `${b.ty1 / 10}%`;
      el.style.width = `${(b.tx2 - b.tx1) / 10}%`;
      el.style.height = `${(b.ty2 - b.ty1) / 10}%`;
      el.style.color = b.textColor;
      if (b.isUniformBg === false) el.style.textShadow = `0 0 3px ${b.bgColor}, 0 0 5px ${b.bgColor}`;
      const sp = document.createElement('span');
      sp.className = 'cbm-text';
      sp.textContent = b.translation;
      el.appendChild(sp);
      el.addEventListener('click', (e) => { e.stopPropagation(); openSheet(rec, b, idx); });
      rec.bubblesEl.appendChild(el);
    });
    rec.lastSize = '';
    requestAnimationFrame(() => syncPos(rec));
  }

  // -------------------- 两级优先级 + 整话后台预翻调度器 --------------------

  function nudgeLazy() {
    let n = 0;
    document.querySelectorAll('img').forEach((img) => {
      if (n >= 3 || !img.isConnected) return;
      if (img.getBoundingClientRect().bottom < -200) return;
      if ((!img.complete || img.naturalWidth === 0) && img.loading === 'lazy') {
        img.loading = 'eager';
        img.addEventListener('load', () => pump(), { once: true });
        n++;
      }
    });
  }

  // -------------------- 一键全话唤醒 data-src + 进度条 --------------------

  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-actualsrc', 'data-cfsrc'];

  function wakeAllLazyImgs() {
    let woken = 0, loading = 0;
    document.querySelectorAll('img').forEach((img) => {
      if (!img.isConnected) return;
      const webtoonHint = /wp-manga-chapter-img|chapter|webtoon|manga/i.test(img.className) || Boolean(img.closest('.reading-content,.page-break,.chapter-content'));
      let lazyUrl = '';
      for (const a of LAZY_ATTRS) {
        const v = (img.getAttribute(a) || '').trim();
        if (v && !v.startsWith('data:image/svg') && !/blank\.gif|spacer\.gif|1x1/i.test(v)) { lazyUrl = v; break; }
      }
      if (!webtoonHint && !lazyUrl && img.getBoundingClientRect().width < 200) return;
      if (img.loading === 'lazy') { img.loading = 'eager'; woken++; }
      const cur = img.currentSrc || img.src || '';
      const placeholder = !cur || cur.startsWith('data:image/svg') || cur.startsWith('data:image/gif') || /placeholder|blank|loading|1x1/i.test(cur) || (img.complete && img.naturalWidth <= 10);
      if (lazyUrl && placeholder) {
        img.setAttribute('src', lazyUrl);
        woken++;
      }
      if (!img.complete || img.naturalWidth <= 10) {
        loading++;
        img.addEventListener('load', () => { updateProg(); pump(); }, { once: true });
      }
    });
    return { woken, loading };
  }

  function updateProg() {
    if (!state.fullChapterMode || window !== window.top) return;
    if (!state.progEl) {
      injectStyles();
      const d = document.createElement('div'); d.id = 'cbm-prog';
      const top = document.createElement('div'); top.className = 'cbm-ptop';
      const txt = document.createElement('span'); txt.className = 'cbm-ptxt';
      const stp = document.createElement('button'); stp.className = 'cbm-pstop'; stp.textContent = '停止';
      stp.onclick = () => {
        state.fullChapterMode = false;
        clearInterval(state.fullChapterTimer);
        d.classList.remove('cbm-show');
        showToast('已停止全话翻译');
      };
      top.append(txt, stp);
      const tr = document.createElement('div'); tr.className = 'cbm-ptrack';
      const fl = document.createElement('div'); fl.className = 'cbm-pfill';
      tr.appendChild(fl);
      d.append(top, tr);
      document.documentElement.appendChild(d);
      state.progEl = d;
    }
    let total = 0, done = 0, bubbles = 0, pending = 0;
    document.querySelectorAll('img').forEach((img) => {
      if (!img.isConnected) return;
      if (isCandidateImg(img)) {
        const rec = state.records.get(img);
        if (rec && rec.stripState) {
          total += rec.stripState.tiles.length; done += rec.stripState.done.size; bubbles += rec.bubbles.length;
        } else if (rec && (rec.status === 'done' || rec.status === 'error')) {
          total += 1; done += 1; bubbles += rec.bubbles.length;
        } else {
          total += 1;
        }
      } else if ((!img.complete || img.naturalWidth <= 10) && (/wp-manga-chapter-img|chapter|webtoon/i.test(img.className) || img.closest('.reading-content,.page-break'))) {
        pending++;
      }
    });
    total += pending;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const bar = state.progEl;
    bar.classList.add('cbm-show');
    bar.querySelector('.cbm-pfill').style.width = `${pct}%`;
    const txt = bar.querySelector('.cbm-ptxt');
    const stp = bar.querySelector('.cbm-pstop');
    if (total > 0 && done >= total && pending === 0 && state.activeRequests === 0) {
      txt.textContent = `全话翻译完成 (100%) · 共 ${bubbles} 处`;
      stp.style.display = 'none';
      state.fullChapterMode = false;
      clearInterval(state.fullChapterTimer);
      clearTimeout(state.progHideTimer);
      state.progHideTimer = setTimeout(() => bar.classList.remove('cbm-show'), 3500);
    } else {
      stp.style.display = '';
      txt.textContent = `全话翻译中 ${done}/${total} (${pct}%) · 已译 ${bubbles} 处`;
    }
  }

  function startFullChapter(force = false) {
    state.fullChapterMode = true;
    state.fullChapterForce = Boolean(force);
    state.cfg.autoTranslate = true;
    if (force) {
      for (const rec of state.records.values()) {
        rec.status = 'idle';
        rec.stripState = null;
        rec.bubbles = [];
      }
    }
    const { woken, loading } = wakeAllLazyImgs();
    updateProg();
    pump();
    clearInterval(state.fullChapterTimer);
    state.fullChapterTimer = setInterval(() => {
      if (!state.fullChapterMode) { clearInterval(state.fullChapterTimer); return; }
      wakeAllLazyImgs();
      pump();
      updateProg();
    }, 1000);
    showToast(`开始全话翻译${woken > 0 ? `（唤醒 ${woken} 张懒图）` : ''}${loading > 0 ? `，载图中 ${loading}` : ''}`);
  }

  function pickWork() {
    const vh = window.innerHeight || 800;
    const vTop = -vh * 0.25, vBot = vh * 1.25, vMid = vh * 0.5;
    const score = (t, b) => (b >= vTop && t <= vBot ? Math.abs((t + b) * 0.5 - vMid) : t > vBot ? 100000 + (t - vBot) : 10000000 + (vTop - b));
    let best = null;
    const consider = (item, sc) => { if (!best || sc < best.sc) best = { item, sc }; };

    for (const rec of state.records.values()) {
      const st = rec.stripState;
      if (!st || !rec.img.isConnected) continue;
      const r = rec.img.getBoundingClientRect();
      for (const tile of st.tiles) {
        if (st.done.has(tile.index) || st.active.has(tile.index)) continue;
        const tt = r.top + (tile.offsetY / st.h) * r.height;
        const tb = r.top + ((tile.offsetY + tile.sliceH) / st.h) * r.height;
        consider({ kind: 'tile', rec, tile }, score(tt, tb));
      }
    }

    if (state.fullChapterMode || isSiteEnabled()) {
      document.querySelectorAll('img').forEach((img) => {
        if (!isCandidateImg(img)) return;
        const rec = state.records.get(img);
        if (rec && rec.status !== 'idle') return;
        const r = img.getBoundingClientRect();
        if (!state.fullChapterMode && r.bottom < vTop) return;
        consider({ kind: 'img', img }, score(r.top, r.bottom) + 50);
      });
    }
    return best ? best.item : null;
  }

  function pump() {
    while (state.activeRequests < state.cfg.maxConcurrency) {
      const w = pickWork();
      if (!w) { nudgeLazy(); break; }

      if (w.kind === 'tile') {
        const { rec, tile } = w;
        const st = rec.stripState;
        st.active.add(tile.index);
        state.activeRequests++;
        (async () => {
          try {
            const dataUrl = encodeTile(st.drawable, st.w, tile.offsetY, tile.sliceH);
            const bubbles = await callVps(dataUrl, st.force);
            if (rec.stripState !== st) return;
            st.done.add(tile.index);
            rec.bubbles = mergeTileBubbles(rec.bubbles, tile, bubbles);
            renderRec(rec);
            if (st.done.size >= st.tiles.length) {
              rec.stripState = null;
              rec.status = 'done';
            }
          } catch (_) {
            st.done.add(tile.index);
          } finally {
            st.active.delete(tile.index);
            state.activeRequests--;
            updateProg();
            pump();
          }
        })();
        continue;
      }

      if (w.kind === 'img') {
        const rec = getOrCreateRec(w.img);
        rec.status = 'loading';
        state.activeRequests++;
        nudgeLazy();
        (async () => {
          try {
            const { drawable, width, height } = await acquireDrawable(w.img);
            if (height / Math.max(1, width) > 2.3 && height > 2200) {
              rec.stripState = { drawable, w: width, h: height, tiles: planTiles(width, height), done: new Set(), active: new Set(), force: state.fullChapterForce };
              rec.status = 'streaming';
            } else {
              const dataUrl = encodeTile(drawable, width, 0, height);
              rec.bubbles = await callVps(dataUrl, state.fullChapterForce);
              rec.status = 'done';
              renderRec(rec);
            }
          } catch (_) {
            rec.status = 'error';
          } finally {
            state.activeRequests--;
            updateProg();
            pump();
          }
        })();
      }
    }
  }

  // -------------------- 触屏悬浮球、原文抽屉与 VPS 设置 --------------------

  function openSheet(rec, b, idx) {
    if (!state.sheetEl) {
      const s = document.createElement('div');
      s.id = 'cbm-sheet';
      document.documentElement.appendChild(s);
      state.sheetEl = s;
    }
    const s = state.sheetEl;
    s.textContent = '';
    const l1 = document.createElement('div'); l1.className = 'cbm-slabel'; l1.textContent = '英文原文';
    const o = document.createElement('div'); o.className = 'cbm-sorig'; o.textContent = b.original;
    const l2 = document.createElement('div'); l2.className = 'cbm-slabel'; l2.textContent = '中文译文（可修改）';
    const inp = document.createElement('textarea'); inp.className = 'cbm-sinput'; inp.value = b.translation;
    const acts = document.createElement('div'); acts.className = 'cbm-sacts';
    const closeB = document.createElement('button'); closeB.className = 'cbm-sbtn'; closeB.textContent = '关闭';
    closeB.onclick = () => s.classList.remove('cbm-open');
    const saveB = document.createElement('button'); saveB.className = 'cbm-sbtn cbm-pri'; saveB.textContent = '保存';
    saveB.onclick = () => {
      if (inp.value.trim()) { rec.bubbles[idx].translation = inp.value.trim(); renderRec(rec); }
      s.classList.remove('cbm-open');
    };
    acts.append(closeB, saveB);
    s.append(l1, o, l2, inp, acts);
    s.classList.add('cbm-open');
  }

  function ensureFab() {
    if (window !== window.top || state.fabEl) return;
    injectStyles();
    const wrap = document.createElement('div'); wrap.id = 'cbm-fab';
    const menu = document.createElement('div'); menu.className = 'cbm-menu';
    const ball = document.createElement('button'); ball.className = 'cbm-ball'; ball.textContent = '译';

    const addBtn = (txt, fn) => {
      const b = document.createElement('button'); b.className = 'cbm-mbtn'; b.textContent = txt;
      b.onclick = (e) => { e.stopPropagation(); menu.classList.remove('cbm-open'); fn(b); };
      menu.appendChild(b);
      return b;
    };

    const togB = addBtn('隐藏译文', (b) => {
      state.overlayVisible = !state.overlayVisible;
      for (const rec of state.records.values()) rec.bubblesEl.classList.toggle('cbm-hidden', !state.overlayVisible);
      b.textContent = state.overlayVisible ? '隐藏译文' : '显示译文';
      showToast(state.overlayVisible ? '已显示译文' : '已显示英文原图');
    });

    addBtn('一键全话翻完', () => {
      startFullChapter(false);
    });

    addBtn('强制全话重译', () => {
      startFullChapter(true);
    });

    addBtn('VPS 设置', () => {
      const url = prompt('VPS 后端地址:', state.cfg.vpsBaseUrl);
      if (url === null) return;
      const tok = prompt('API Token:', state.cfg.vpsApiToken);
      if (tok === null) return;
      state.cfg.vpsBaseUrl = url.trim().replace(/\/+$/, '');
      state.cfg.vpsApiToken = tok.trim();
      saveCfg(state.cfg);
      showToast('VPS 配置已保存');
      pump();
    });

    addBtn('隐藏悬浮球', () => { wrap.style.display = 'none'; });

    let drag = false, moved = false, sx = 0, sy = 0, or = 14, ob = 76;
    ball.addEventListener('touchstart', (e) => {
      drag = true; moved = false;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      or = parseFloat(wrap.style.right) || 14; ob = parseFloat(wrap.style.bottom) || 76;
    }, { passive: true });
    ball.addEventListener('touchmove', (e) => {
      if (!drag) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      wrap.style.right = `${Math.max(8, Math.min(window.innerWidth - 56, or - dx))}px`;
      wrap.style.bottom = `${Math.max(16, Math.min(window.innerHeight - 66, ob - dy))}px`;
    }, { passive: true });
    ball.addEventListener('touchend', () => { drag = false; }, { passive: true });
    ball.onclick = (e) => {
      e.stopPropagation();
      if (moved) { moved = false; return; }
      togB.textContent = state.overlayVisible ? '隐藏译文' : '显示译文';
      menu.classList.toggle('cbm-open');
    };

    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) menu.classList.remove('cbm-open'); });
    wrap.append(menu, ball);
    document.documentElement.appendChild(wrap);
    state.fabEl = wrap;
  }

  function scheduleSync() {
    if (state.layoutRaf) return;
    state.layoutRaf = requestAnimationFrame(() => {
      state.layoutRaf = null;
      for (const rec of state.records.values()) syncPos(rec);
      pump();
    });
  }

  window.addEventListener('scroll', scheduleSync, { passive: true, capture: true });
  window.addEventListener('resize', scheduleSync, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleSync, { passive: true });

  new MutationObserver(() => scheduleSync()).observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(() => { pump(); }, 800);
  setTimeout(() => { pump(); }, 2500);
})();
