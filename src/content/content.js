(function () {
  'use strict';

  const Config = globalThis.ComicBubbleConfig;
  const ImgUtils = globalThis.ComicBubbleImageUtils;
  if (!Config || !ImgUtils) return;

  // -------------------- 全局运行状态 --------------------

  const state = {
    settings: Config.DEFAULT_SETTINGS,
    overlayVisible: true,
    activeRequests: 0,
    queue: [],
    queuedSet: new Set(),
    records: new Map(), // Element (img | canvas | div) -> record
    lastRightClickedTarget: null,
    lastRightClickTs: 0,
    tooltipEl: null,
    toastEl: null,
    toastTimer: null,
    mobileFabEl: null,
    mobileSheetEl: null,
    progressEl: null,
    progressHideTimer: null,
    fullChapterMode: false,
    fullChapterForce: false,
    fullChapterTimer: null,
    layoutRaf: null,
    intersectionObserver: null,
    mutationObserver: null,
    resizeObserver: null
  };

  function isMobileDevice() {
    return (
      window.innerWidth <= 680 ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
      /Android|Mobile|HarmonyOS/i.test(navigator.userAgent || '')
    );
  }

  // -------------------- Tooltip 与 Toast --------------------

  function ensureGlobalPopups() {
    if (!state.tooltipEl || !document.documentElement.contains(state.tooltipEl)) {
      const tip = document.createElement('div');
      tip.id = 'cb-tooltip';
      document.documentElement.appendChild(tip);
      state.tooltipEl = tip;
    }
    if (!state.toastEl || !document.documentElement.contains(state.toastEl)) {
      const toast = document.createElement('div');
      toast.id = 'cb-toast';
      document.documentElement.appendChild(toast);
      state.toastEl = toast;
    }
  }

  function showToast(text, duration = 2600) {
    ensureGlobalPopups();
    state.toastEl.textContent = text;
    state.toastEl.classList.add('cb-show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      if (state.toastEl) state.toastEl.classList.remove('cb-show');
    }, duration);
  }

  function showTooltip(bubble, clientX, clientY) {
    if (!state.settings.showOriginalOnHover || !bubble || !bubble.original) return;
    ensureGlobalPopups();
    const tip = state.tooltipEl;
    tip.textContent = '';

    const tag = document.createElement('div');
    tag.className = 'cb-tooltip-tag';
    tag.textContent = '英文原文 (Original)';
    tip.appendChild(tag);

    const body = document.createElement('div');
    body.textContent = bubble.original;
    tip.appendChild(body);

    const hint = document.createElement('span');
    hint.className = 'cb-tooltip-hint';
    hint.textContent = '双击气泡可微调译文 · Alt+T 切换对照';
    tip.appendChild(hint);

    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('cb-show');
    const r = tip.getBoundingClientRect();
    let x = clientX + 14;
    let y = clientY + 14;
    if (x + r.width > window.innerWidth - 10) x = Math.max(10, clientX - r.width - 14);
    if (y + r.height > window.innerHeight - 10) y = Math.max(10, clientY - r.height - 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function hideTooltip() {
    if (state.tooltipEl) state.tooltipEl.classList.remove('cb-show');
  }

  // -------------------- Android / 移动端触屏悬浮球与底部原文对照抽屉 --------------------

  function ensureMobileFab() {
    if (!isMobileDevice() || window !== window.top) return;
    if (state.mobileFabEl && document.documentElement.contains(state.mobileFabEl)) return;

    const wrap = document.createElement('div');
    wrap.id = 'cb-mobile-fab';

    const menu = document.createElement('div');
    menu.className = 'cb-fab-menu';

    const mkBtn = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cb-fab-item';
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('cb-open');
        ball.classList.remove('cb-fab-open');
        onClick(b);
      });
      return b;
    };

    const toggleItem = mkBtn(state.overlayVisible ? '隐藏译文' : '显示译文', (btn) => {
      state.overlayVisible = !state.overlayVisible;
      for (const rec of state.records.values()) {
        rec.localHidden = false;
        updateRecordVisibility(rec);
      }
      btn.textContent = state.overlayVisible ? '隐藏译文' : '显示译文';
      showToast(state.overlayVisible ? '已显示中文译文' : '已切换显示英文原图');
    });

    const scanItem = mkBtn('一键全话翻完', () => {
      startFullChapterTranslation(false);
    });

    const forceItem = mkBtn('强制全话重译', () => {
      startFullChapterTranslation(true);
    });

    const hideFabItem = mkBtn('收起按钮', () => {
      wrap.style.display = 'none';
      showToast('已隐藏悬浮球，刷新页面可恢复');
    });

    menu.append(toggleItem, scanItem, forceItem, hideFabItem);

    const ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'cb-fab-ball';
    ball.textContent = '译';
    ball.setAttribute('aria-label', 'ComicBubble AI 菜单');

    // 支持手指拖动悬浮球位置，不挡漫画对白
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, origRight = 14, origBottom = 76;

    ball.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      dragging = true;
      moved = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      origRight = parseFloat(wrap.style.right) || 14;
      origBottom = parseFloat(wrap.style.bottom) || 76;
    }, { passive: true });

    ball.addEventListener('touchmove', (e) => {
      if (!dragging || !e.touches || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      const nr = Math.max(8, Math.min(window.innerWidth - 56, origRight - dx));
      const nb = Math.max(16, Math.min(window.innerHeight - 66, origBottom - dy));
      wrap.style.right = `${nr}px`;
      wrap.style.bottom = `${nb}px`;
    }, { passive: true });

    ball.addEventListener('touchend', () => { dragging = false; }, { passive: true });

    ball.addEventListener('click', (e) => {
      e.stopPropagation();
      if (moved) { moved = false; return; }
      toggleItem.textContent = state.overlayVisible ? '隐藏译文' : '显示译文';
      const opening = !menu.classList.contains('cb-open');
      menu.classList.toggle('cb-open', opening);
      ball.classList.toggle('cb-fab-open', opening);
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) {
        menu.classList.remove('cb-open');
        ball.classList.remove('cb-fab-open');
      }
    });

    wrap.append(menu, ball);
    document.documentElement.appendChild(wrap);
    state.mobileFabEl = wrap;
  }

  function openMobileBubbleSheet(rec, bubble, index) {
    if (!state.mobileSheetEl || !document.documentElement.contains(state.mobileSheetEl)) {
      const sheet = document.createElement('div');
      sheet.id = 'cb-mobile-sheet';
      document.documentElement.appendChild(sheet);
      state.mobileSheetEl = sheet;
    }

    const sheet = state.mobileSheetEl;
    sheet.textContent = '';

    const lblOrig = document.createElement('div');
    lblOrig.className = 'cb-sheet-label';
    lblOrig.textContent = '英文原文 (Original)';

    const origBox = document.createElement('div');
    origBox.className = 'cb-sheet-orig';
    origBox.textContent = bubble.original || '(无原文)';

    const lblZh = document.createElement('div');
    lblZh.className = 'cb-sheet-label';
    lblZh.textContent = '中文译文（可直接修改）';

    const input = document.createElement('textarea');
    input.className = 'cb-sheet-input';
    input.value = bubble.translation || '';

    const actions = document.createElement('div');
    actions.className = 'cb-sheet-actions';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cb-sheet-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => sheet.classList.remove('cb-open'));

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'cb-sheet-btn cb-primary';
    saveBtn.textContent = '保存译文';
    saveBtn.addEventListener('click', () => {
      const updated = input.value.trim();
      if (updated && updated !== bubble.translation) {
        rec.bubbles[index].translation = updated;
        const imageKey = getTargetIdentity(rec.el);
        if (imageKey) {
          chrome.runtime.sendMessage({
            type: 'SAVE_CACHED_TRANSLATION',
            imageKey,
            bubbles: rec.bubbles
          });
        }
        renderBubbles(rec);
        showToast('已更新该气泡译文');
      }
      sheet.classList.remove('cb-open');
    });

    actions.append(closeBtn, saveBtn);
    sheet.append(lblOrig, origBox, lblZh, input, actions);
    sheet.classList.add('cb-open');
  }

  // -------------------- 全形态漫画载体识别 (img / canvas / background-image div) --------------------

  function isIgnoredAncestor(el) {
    let cur = el.parentElement;
    let depth = 0;
    while (cur && depth < 6) {
      const tag = cur.tagName;
      if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
      const cls = String(cur.className || '') + ' ' + String(cur.id || '');
      if (/\b(ad|ads|advert|banner|avatar|logo|emoji|sticker|icon|thumbnail|thumb|cb-layer-container)\b/i.test(cls)) {
        return true;
      }
      cur = cur.parentElement;
      depth++;
    }
    return false;
  }

  function isWebtoonReaderImage(el) {
    if (!(el instanceof HTMLImageElement)) return false;
    const cls = String(el.className || '');
    if (/wp-manga-chapter-img|chapter-img|webtoon|comic-page|manga-page/i.test(cls)) return true;
    if (el.closest('.reading-content, .page-break, .chapter-content, .viewer_img, #viewer, .manga-reader')) {
      return true;
    }
    return false;
  }

  function isCandidateComicElement(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (el.closest('.cb-layer-container')) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    const minW = state.settings.minImageWidth;
    const minH = state.settings.minImageHeight;
    const mobile = isMobileDevice();
    const vw = window.innerWidth || 390;

    // 针对条漫碎图（ToonGod / Webtoon）及手机竖屏（逻辑宽 360~430px）动态放宽尺寸门槛
    const webtoonHint = isWebtoonReaderImage(el);
    const wideStrip = mobile
      ? rect.width >= vw * 0.58 && (webtoonHint || (el instanceof HTMLImageElement && el.naturalWidth >= 360))
      : rect.width >= 380 && (webtoonHint || (el instanceof HTMLImageElement && el.naturalWidth >= 480));
    const minRenderW = mobile ? Math.min(minW, Math.round(vw * 0.52)) : Math.min(minW, 240);
    const effectiveMinH = wideStrip ? (mobile ? 75 : Math.min(minH, 100)) : (mobile ? Math.min(minH, 160) : minH);
    const minArea = wideStrip ? (mobile ? 22000 : 45000) : (mobile ? 45000 : 110000);
    const maxRatio = wideStrip ? 7.5 : 4.2;

    if (rect.width < minRenderW || rect.height < Math.min(effectiveMinH, 75)) return false;
    if (rect.width * rect.height < minArea) return false;
    if (rect.width / rect.height > maxRatio) return false;
    // 大尺寸漫画正文图或条漫阅读器图不做祖先 class 关键字拦截
    const isLargeVisual = mobile ? rect.width >= vw * 0.65 && rect.height >= 240 : rect.width >= 450 && rect.height >= 450;
    if (!webtoonHint && !isLargeVisual && isIgnoredAncestor(el)) return false;

    if (el instanceof HTMLImageElement) {
      const src = el.currentSrc || el.src || '';
      if (!src || src.startsWith('data:image/svg+xml') || /\.svg(\?|$)/i.test(src) || src.endsWith('.gif')) {
        return false;
      }
      const natW = el.naturalWidth || 0;
      const natH = el.naturalHeight || 0;
      const minNatW = mobile ? Math.min(minW, 240) : minW;
      return natW >= minNatW && natH >= effectiveMinH;
    }

    if (el instanceof HTMLCanvasElement) {
      return el.width >= minW && el.height >= minH;
    }

    if (el.tagName === 'DIV') {
      // 仅针对纯背景图漫画节点，避免误判带大量子元素的普通容器 div
      if (el.querySelector('img, canvas, video, p, article, section')) return false;
      const bgUrl = ImgUtils.extractBackgroundImageUrl(el);
      return Boolean(bgUrl);
    }

    return false;
  }

  function getTargetIdentity(el) {
    if (el instanceof HTMLImageElement) {
      const src = el.currentSrc || el.src || '';
      if (!src) return '';
      if (src.startsWith('data:')) return `data_${src.length}_${src.slice(0, 72)}_${src.slice(-48)}`;
      if (src.startsWith('blob:')) return `blob_${location.origin}_${el.naturalWidth}x${el.naturalHeight}_${src}`;
      return src;
    }
    if (el instanceof HTMLCanvasElement) {
      // Canvas 可能动态重绘，使用当前页路径 + 尺寸 + 页面内序位（仅用于同帧去重，不强依赖缓存）
      return '';
    }
    return ImgUtils.extractBackgroundImageUrl(el) || '';
  }

  function guessFilename(el) {
    const src = el instanceof HTMLImageElement ? el.currentSrc || el.src : ImgUtils.extractBackgroundImageUrl(el);
    try {
      const u = new URL(src, location.href);
      const base = u.pathname.split('/').pop() || 'comic';
      return base.replace(/\.[^.]+$/, '') || 'comic';
    } catch (_) {
      return 'comic-page';
    }
  }

  // -------------------- IsManga 风格：就近父容器挂载与精准定位 --------------------

  function getFirstNonInlineParent(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      if (window.getComputedStyle(p).display !== 'inline') return p;
      p = p.parentElement;
    }
    return document.body || document.documentElement;
  }

  function getOrCreateRecord(el) {
    let rec = state.records.get(el);
    if (rec) return rec;

    const layer = document.createElement('span');
    layer.className = 'cb-layer-container';

    const bubblesEl = document.createElement('div');
    bubblesEl.className = 'cb-bubbles-container';
    if (!state.overlayVisible) bubblesEl.classList.add('cb-hidden');

    const toolbar = document.createElement('div');
    toolbar.className = 'cb-toolbar';

    const dot = document.createElement('span');
    dot.className = 'cb-status-dot';

    const label = document.createElement('span');
    label.className = 'cb-status-label';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'cb-btn';
    toggleBtn.textContent = '原文';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'cb-btn';
    retryBtn.textContent = '重译';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'cb-btn';
    exportBtn.textContent = '导出';

    toolbar.append(dot, label, toggleBtn, retryBtn, exportBtn);
    layer.append(bubblesEl, toolbar);

    // 就近挂载在漫画元素的非行内父节点中，避免跨滚动容器漂移
    const parent = getFirstNonInlineParent(el);
    const pStyle = window.getComputedStyle(parent);
    if (pStyle.position === 'static') {
      parent.style.position = 'relative';
    }
    // 对 <picture> 内部的 <img> 挂到 <picture> 后，避免破坏 <picture> 结构
    const anchor = el.parentElement && el.parentElement.tagName === 'PICTURE' ? el.parentElement : el;
    if (anchor.parentNode) {
      anchor.insertAdjacentElement('afterend', layer);
    } else {
      parent.appendChild(layer);
    }

    rec = {
      el,
      src: getTargetIdentity(el),
      status: 'idle',
      bubbles: [],
      localHidden: false,
      errorMsg: '',
      lastFitSize: '',
      layer,
      bubblesEl,
      toolbar,
      label,
      toggleBtn,
      retryBtn,
      exportBtn
    };

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      rec.localHidden = !rec.localHidden;
      updateRecordVisibility(rec);
    });

    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enqueueTarget(el, { force: true, highPriority: true });
    });

    exportBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!rec.bubbles || rec.bubbles.length === 0) {
        showToast('此画面暂无可导出的气泡译文');
        return;
      }
      exportBtn.disabled = true;
      const oldText = exportBtn.textContent;
      exportBtn.textContent = '导出中...';
      try {
        await ImgUtils.renderAndDownloadTranslatedImage(el, rec.bubbles, state.settings, guessFilename(el));
        showToast('高清无痕译后图已开始下载');
      } catch (err) {
        showToast(`导出失败: ${err.message || err}`);
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = oldText;
      }
    });

    state.records.set(el, rec);
    if (state.resizeObserver) state.resizeObserver.observe(el);
    ensureMobileFab();
    syncRecordPosition(rec);
    return rec;
  }

  function updateRecordVisibility(rec) {
    const shouldHide = !state.overlayVisible || rec.localHidden;
    rec.bubblesEl.classList.toggle('cb-hidden', shouldHide);
    rec.toggleBtn.textContent = shouldHide ? '译文' : '原文';
  }

  function updateToolbar(rec) {
    rec.toolbar.classList.remove('cb-status-loading', 'cb-status-done', 'cb-status-error', 'cb-toolbar-active');
    if (rec.status === 'queued') {
      rec.toolbar.classList.add('cb-status-loading', 'cb-toolbar-active');
      rec.label.textContent = '排队中...';
      rec.toggleBtn.style.display = 'none';
      rec.exportBtn.style.display = 'none';
    } else if (rec.status === 'loading') {
      rec.toolbar.classList.add('cb-status-loading', 'cb-toolbar-active');
      rec.label.textContent = '擦字翻译中...';
      rec.toggleBtn.style.display = 'none';
      rec.exportBtn.style.display = 'none';
    } else if (rec.status === 'done') {
      rec.toolbar.classList.add('cb-status-done');
      rec.label.textContent = rec.bubbles.length > 0 ? `已译 ${rec.bubbles.length} 处` : '无英文气泡';
      rec.toggleBtn.style.display = rec.bubbles.length > 0 ? '' : 'none';
      rec.exportBtn.style.display = rec.bubbles.length > 0 ? '' : 'none';
      updateRecordVisibility(rec);
    } else if (rec.status === 'error') {
      rec.toolbar.classList.add('cb-status-error', 'cb-toolbar-active');
      rec.label.textContent = rec.errorMsg || '翻译失败';
      rec.label.title = rec.errorMsg || '翻译失败';
      rec.toggleBtn.style.display = 'none';
      rec.exportBtn.style.display = 'none';
    }
  }

  function syncRecordPosition(rec) {
    if (!rec.el.isConnected) {
      cleanupRecord(rec.el);
      return;
    }
    const style = window.getComputedStyle(rec.el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      rec.layer.style.display = 'none';
      return;
    }

    const box = ImgUtils.getRenderedTargetBox(rec.el);
    if (box.width < 40 || box.height < 40) {
      rec.layer.style.display = 'none';
      return;
    }

    const offsetParent = rec.layer.offsetParent || document.documentElement;
    const pRect = offsetParent.getBoundingClientRect();
    const pStyle = window.getComputedStyle(offsetParent);
    const pBorL = parseFloat(pStyle.borderLeftWidth) || 0;
    const pBorT = parseFloat(pStyle.borderTopWidth) || 0;
    const scrollL = offsetParent === document.documentElement ? 0 : offsetParent.scrollLeft;
    const scrollT = offsetParent === document.documentElement ? 0 : offsetParent.scrollTop;

    const left = box.left - pRect.left - pBorL + scrollL;
    const top = box.top - pRect.top - pBorT + scrollT;

    rec.layer.style.display = 'block';
    rec.layer.style.left = `${left.toFixed(1)}px`;
    rec.layer.style.top = `${top.toFixed(1)}px`;
    rec.layer.style.width = `${box.width.toFixed(1)}px`;
    rec.layer.style.height = `${box.height.toFixed(1)}px`;

    const sizeKey = `${Math.round(box.width)}x${Math.round(box.height)}_${rec.bubbles.length}`;
    // 关键修复：流式加载/按需分片期间只要已有气泡就立即执行原字号自适应，不等全部切片完成！
    if (rec.bubbles.length > 0 && rec.lastFitSize !== sizeKey) {
      rec.lastFitSize = sizeKey;
      layoutAndFitBubbles(rec, box.width, box.height);
    }
  }

  function scheduleLayoutSync() {
    if (state.layoutRaf) return;
    state.layoutRaf = requestAnimationFrame(() => {
      state.layoutRaf = null;
      for (const rec of state.records.values()) {
        syncRecordPosition(rec);
      }
      // 滚动时动态按当前视口优先级抢占调度
      pumpAllWork();
    });
  }

  function cleanupRecord(el) {
    const rec = state.records.get(el);
    if (!rec) return;
    if (state.resizeObserver) state.resizeObserver.unobserve(el);
    if (rec.layer && rec.layer.parentNode) rec.layer.remove();
    state.records.delete(el);
  }

  // -------------------- IsManga 风格：防重叠推移 + 多候选断句二分最大字号 --------------------

  function resolveBubbleOverlaps(rects, containerW, containerH) {
    const MAX_SHIFT = 28;
    const items = rects.map((r) => ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      ox: 0,
      oy: 0
    }));

    for (let iter = 0; iter < 6; iter++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];
          const ax1 = a.left + a.ox, ay1 = a.top + a.oy;
          const ax2 = ax1 + a.width, ay2 = ay1 + a.height;
          const bx1 = b.left + b.ox, by1 = b.top + b.oy;
          const bx2 = bx1 + b.width, by2 = by1 + b.height;

          const overlapX = Math.min(ax2, bx2) - Math.max(ax1, bx1);
          const overlapY = Math.min(ay2, by2) - Math.max(ay1, by1);
          if (overlapX <= 2 || overlapY <= 2) continue;

          // 按较小重叠轴轻柔推开相邻文字框
          if (overlapY <= overlapX) {
            const shift = overlapY / 2 + 1;
            const dir = ay1 + a.height / 2 <= by1 + b.height / 2 ? -1 : 1;
            a.oy = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, a.oy + dir * shift));
            b.oy = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, b.oy - dir * shift));
          } else {
            const shift = overlapX / 2 + 1;
            const dir = ax1 + a.width / 2 <= bx1 + b.width / 2 ? -1 : 1;
            a.ox = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, a.ox + dir * shift));
            b.ox = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, b.ox - dir * shift));
          }
          moved = true;
        }
      }
      if (!moved) break;
    }

    return items.map((it, idx) => {
      const allowOut = rects[idx] && rects[idx].crossSeam;
      return {
        left: Math.max(0, Math.min(containerW - it.width, it.left + it.ox)),
        top: allowOut ? Math.max(0, it.top + it.oy) : Math.max(0, Math.min(containerH - it.height, it.top + it.oy)),
        width: it.width,
        height: it.height
      };
    });
  }

  function buildLineBreakCandidates(text) {
    const raw = String(text || '').trim();
    const list = [raw];
    const bySentence = raw.replace(/([。！？…])(?=[^\s”」』】）》])/g, '$1\n');
    if (bySentence !== raw) list.push(bySentence);
    // 长句同时尝试按逗号/顿号自然断行，避免长旁白框被压成单行小字
    if (raw.length >= 14) {
      const byClause = raw.replace(/([，、；。！？…])(?=[^\s”」』】）》])/g, '$1\n');
      if (byClause !== raw && byClause !== bySentence) list.push(byClause);
    }
    return list;
  }

  function fitSingleBubbleFont(bubbleEl, textEl, bubble, targetW, targetH, containerH) {
    const boxW = Math.max(16, targetW - 4);
    const boxH = Math.max(16, targetH - 4);
    const candidates = buildLineBreakCandidates(bubble.translation);

    // 根据 VPS 测得的原英文行高比例 (origFontRatio) 自动匹配醒目的真实漫画字号（手机小屏放宽下限至 9px）
    const mobile = isMobileDevice();
    const minPx = mobile ? 9 : 11;
    let maxPx;
    if (bubble.origFontRatio > 0 && containerH > 0) {
      const detectedPx = Math.round(bubble.origFontRatio * containerH * (mobile ? 1.15 : 1.2));
      maxPx = Math.max(mobile ? 11 : 14, Math.min(mobile ? 32 : 44, Math.round(detectedPx * 1.25)));
    } else {
      maxPx = Math.min(mobile ? 26 : 34, Math.max(mobile ? 11 : 14, Math.floor(Math.min(boxW, boxH) * 0.55)));
    }

    let bestSize = minPx;
    let bestText = candidates[0];
    let foundFit = false;

    for (const cand of candidates) {
      textEl.textContent = cand;
      let lo = minPx;
      let hi = maxPx;
      let fitSize = null;

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        textEl.style.fontSize = `${mid}px`;
        if (textEl.scrollHeight <= boxH + 3 && textEl.scrollWidth <= boxW + 4) {
          fitSize = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (fitSize !== null && (!foundFit || fitSize > bestSize)) {
        foundFit = true;
        bestSize = fitSize;
        bestText = cand;
      }
    }

    textEl.textContent = bestText;
    textEl.style.fontSize = `${bestSize}px`;
  }

  function layoutAndFitBubbles(rec, containerW, containerH) {
    const bubbleEls = Array.from(rec.bubblesEl.querySelectorAll('.cb-bubble'));
    if (bubbleEls.length === 0 || !containerW || !containerH) return;

    // 使用 VPS 向气泡内部安全扩展后的排版框 (tx1..ty2) 做防重叠排版
    const rawRects = rec.bubbles.map((b) => {
      const x1 = b.tx1 !== undefined ? b.tx1 : b.x1;
      const y1 = b.ty1 !== undefined ? b.ty1 : b.y1;
      const x2 = b.tx2 !== undefined ? b.tx2 : b.x2;
      const y2 = b.ty2 !== undefined ? b.ty2 : b.y2;
      return {
        left: (x1 / 1000) * containerW,
        top: (y1 / 1000) * containerH,
        width: Math.max(20, ((x2 - x1) / 1000) * containerW),
        height: Math.max(16, ((y2 - y1) / 1000) * containerH),
        crossSeam: Boolean(b.crossSeam)
      };
    });
    const resolved = resolveBubbleOverlaps(rawRects, containerW, containerH);

    bubbleEls.forEach((node, idx) => {
      const r = resolved[idx];
      const b = rec.bubbles[idx];
      if (!r || !b) return;
      node.style.left = `${r.left.toFixed(1)}px`;
      node.style.top = `${r.top.toFixed(1)}px`;
      node.style.width = `${r.width.toFixed(1)}px`;
      node.style.height = `${r.height.toFixed(1)}px`;
      const textEl = node.querySelector('.cb-bubble-text');
      if (textEl) fitSingleBubbleFont(node, textEl, b, r.width, r.height, containerH);
    });
  }

  function renderBubbles(rec) {
    rec.bubblesEl.textContent = '';
    const hasCrossSeam = rec.bubbles.some((b) => b.crossSeam);
    rec.bubblesEl.classList.toggle('cb-allow-overflow', hasCrossSeam);
    // 跨缝气泡所在的上一张图覆盖层略微提权，确保跨过接缝不被下一张图遮挡
    rec.layer.style.zIndex = hasCrossSeam ? '10010' : '9999';
    const settings = state.settings;

    rec.bubbles.forEach((bubble, index) => {
      // 第 1 层：无痕擦字贴片层（inpaintingDataUrl）或回退柔边底色层
      const patch = document.createElement('div');
      patch.className = 'cb-inpaint-patch';

      if (bubble.inpaintingDataUrl) {
        patch.style.left = `${bubble.x1 / 10}%`;
        patch.style.top = `${bubble.y1 / 10}%`;
        patch.style.width = `${(bubble.x2 - bubble.x1) / 10}%`;
        patch.style.height = `${(bubble.y2 - bubble.y1) / 10}%`;
        patch.style.backgroundImage = `url(${bubble.inpaintingDataUrl})`;
        patch.style.backgroundSize = '100% 100%';
        // 无痕透明贴片必须 100% 不透明，杜绝底层英文黑字透出残影
        patch.style.opacity = '1';
      } else {
        const bw = bubble.x2 - bubble.x1;
        const bh = bubble.y2 - bubble.y1;
        const padX = Math.min(10, bw * 0.035);
        const padY = Math.min(10, bh * 0.035);
        const leftPct = Math.max(0, (bubble.x1 - padX) / 10);
        const topPct = Math.max(0, (bubble.y1 - padY) / 10);
        patch.classList.add(bubble.shape === 'rect' || bubble.type === 'narration' ? 'cb-fallback-rect' : 'cb-fallback-ellipse');
        patch.style.left = `${leftPct}%`;
        patch.style.top = `${topPct}%`;
        patch.style.width = `${Math.min(100 - leftPct, (bw + padX * 2) / 10)}%`;
        patch.style.height = `${Math.min(100 - topPct, (bh + padY * 2) / 10)}%`;
        patch.style.backgroundColor = bubble.bgColor || '#FFFFFF';
        patch.style.boxShadow = `0 0 6px 2px ${bubble.bgColor || '#FFFFFF'}`;
        patch.style.opacity = String(settings.overlayOpacity);
      }
      rec.bubblesEl.appendChild(patch);

      // 第 2 层：中文译文交互层
      const el = document.createElement('div');
      el.className = 'cb-bubble';
      if (bubble.type === 'sfx') el.classList.add('cb-type-sfx');
      if (settings.clickThrough) el.classList.add('cb-click-through');

      const tx1 = bubble.tx1 !== undefined ? bubble.tx1 : bubble.x1;
      const ty1 = bubble.ty1 !== undefined ? bubble.ty1 : bubble.y1;
      const tx2 = bubble.tx2 !== undefined ? bubble.tx2 : bubble.x2;
      const ty2 = bubble.ty2 !== undefined ? bubble.ty2 : bubble.y2;
      el.style.left = `${tx1 / 10}%`;
      el.style.top = `${ty1 / 10}%`;
      el.style.width = `${(tx2 - tx1) / 10}%`;
      el.style.height = `${(ty2 - ty1) / 10}%`;
      el.style.color = bubble.textColor || '#141414';
      el.style.fontFamily = settings.fontFamily;
      el.style.fontWeight = settings.fontWeight;
      // 非纯色复杂背景（如网点/彩图上的无框字）自动加极细底色描边阴影，保证可读性且无方框感
      if (bubble.isUniformBg === false) {
        const halo = bubble.bgColor || '#FFFFFF';
        el.style.textShadow = `0 0 3px ${halo}, 0 0 5px ${halo}`;
      }

      const textEl = document.createElement('span');
      textEl.className = 'cb-bubble-text';
      textEl.textContent = bubble.translation;
      el.appendChild(textEl);

      el.addEventListener('mouseenter', (e) => {
        if (!isMobileDevice()) showTooltip(bubble, e.clientX, e.clientY);
      });
      el.addEventListener('mousemove', (e) => {
        if (!isMobileDevice()) showTooltip(bubble, e.clientX, e.clientY);
      });
      el.addEventListener('mouseleave', hideTooltip);

      // Android 触屏：轻点气泡弹出底部原文对照与编辑抽屉（不触发双击缩放）
      el.addEventListener('click', (e) => {
        if (!isMobileDevice()) return;
        e.stopPropagation();
        openMobileBubbleSheet(rec, bubble, index);
      });

      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        hideTooltip();
        if (el.querySelector('textarea')) return;

        const editor = document.createElement('textarea');
        editor.className = 'cb-bubble-editor';
        editor.value = bubble.translation;
        el.textContent = '';
        el.appendChild(editor);
        editor.focus();
        editor.select();

        const commit = () => {
          const updated = editor.value.trim();
          if (updated) {
            rec.bubbles[index].translation = updated;
            const imageKey = getTargetIdentity(rec.el);
            if (imageKey) {
              chrome.runtime.sendMessage({
                type: 'SAVE_CACHED_TRANSLATION',
                imageKey,
                bubbles: rec.bubbles
              });
            }
          }
          renderBubbles(rec);
        };

        editor.addEventListener('blur', commit);
        editor.addEventListener('keydown', (ke) => {
          if (ke.key === 'Escape') renderBubbles(rec);
          else if (ke.key === 'Enter' && !ke.shiftKey) {
            ke.preventDefault();
            editor.blur();
          }
        });
      });

      rec.bubblesEl.appendChild(el);
    });

    rec.lastFitSize = '';
    requestAnimationFrame(() => syncRecordPosition(rec));
  }

  /**
   * 检测当前图片下方是否紧贴着 1~3 张同宽短条漫切片（如 ToonGod / Webtoon 连续碎图）
   * 满足条件时自动合并送翻，根治跨图腰斩气泡并减少请求次数
   */
  function findAdjacentWebtoonGroup(startEl) {
    if (!(startEl instanceof HTMLImageElement)) return [startEl];
    if (!startEl.complete || startEl.naturalHeight <= 0 || startEl.naturalHeight >= 1350) {
      return [startEl];
    }

    const allImgs = Array.from(document.querySelectorAll('img')).filter(
      (img) => img.isConnected && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0
    );
    const idx = allImgs.indexOf(startEl);
    if (idx === -1) return [startEl];

    const group = [startEl];
    let prevRect = startEl.getBoundingClientRect();
    let totalNatH = startEl.naturalHeight;

    for (let i = idx + 1; i < allImgs.length && group.length < 4; i++) {
      const next = allImgs[i];
      if (!isCandidateComicElement(next)) break;
      const existing = state.records.get(next);
      if (existing && (existing.status === 'done' || existing.status === 'loading')) break;

      const nextRect = next.getBoundingClientRect();
      const gap = nextRect.top - prevRect.bottom;
      const widthDiff = Math.abs(nextRect.width - prevRect.width);
      const leftDiff = Math.abs(nextRect.left - prevRect.left);

      // 判定标准：紧贴垂直排列（缝隙 <= 10px）、同宽对齐、总高 <= 2200px
      if (gap < -4 || gap > 10 || widthDiff > 16 || leftDiff > 16) break;
      if (totalNatH + next.naturalHeight > 2200) break;

      group.push(next);
      totalNatH += next.naturalHeight;
      prevRect = nextRect;
    }

    return group;
  }

  async function processStitchedWebtoonGroup(groupEls, force) {
    const recs = groupEls.map((el) => {
      // 从待处理队列中移出已并入合带的后续切片，避免重复翻
      state.queue = state.queue.filter((t) => t.el !== el);
      state.queuedSet.delete(el);
      const rec = getOrCreateRecord(el);
      rec.src = getTargetIdentity(el);
      rec.status = 'loading';
      rec.errorMsg = '';
      updateToolbar(rec);
      rec.label.textContent = `拼带识别 (${groupEls.length}片)...`;
      return rec;
    });

    try {
      const items = [];
      for (const el of groupEls) {
        const d = await ImgUtils.acquireCleanDrawable(el);
        items.push({ el, drawable: d.drawable, width: d.width, height: d.height });
      }
      const stitched = ImgUtils.stitchDrawablesVertically(items, state.settings.maxImageDimension);
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_VPS_IMAGE',
        dataUrl: stitched.dataUrl,
        pageTitle: document.title || '',
        pageUrl: location.href || '',
        force: Boolean(force)
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'VPS 拼带擦字失败');

      const splitList = ImgUtils.splitStitchedBubbles(stitched, res.bubbles || []);
      for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        rec.bubbles = splitList[i] || [];
        rec.status = 'done';
        const key = getTargetIdentity(rec.el);
        if (state.settings.enableCache && key) {
          chrome.runtime.sendMessage({
            type: 'SAVE_CACHED_TRANSLATION',
            imageKey: key,
            bubbles: rec.bubbles
          });
        }
        renderBubbles(rec);
        updateToolbar(rec);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      recs.forEach((rec) => {
        rec.status = 'error';
        rec.errorMsg = msg;
        updateToolbar(rec);
      });
    }
  }

  /**
   * 强制唤醒整话所有懒加载漫画原图（兼容 data-src / data-lazy-src / data-original / loading="lazy"）
   */
  const LAZY_SRC_ATTRS = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-url',
    'data-actualsrc',
    'data-cfsrc',
    'data-img',
    'data-image'
  ];

  function extractLazyRealUrl(img) {
    for (const attr of LAZY_SRC_ATTRS) {
      const val = (img.getAttribute(attr) || '').trim();
      if (!val) continue;
      if (val.startsWith('data:image/svg') || /blank\.gif|spacer\.gif|loading\.gif|1x1/i.test(val)) {
        continue;
      }
      if (/^(https?:)?\/\/|^\//i.test(val) || /\.(jpe?g|png|webp|avif)(\?|$)/i.test(val)) {
        return val;
      }
    }
    return '';
  }

  function isLikelyChapterLazyImg(img) {
    if (isWebtoonReaderImage(img)) return true;
    const r = img.getBoundingClientRect();
    if (r.width >= 260) return true;
    const realUrl = extractLazyRealUrl(img);
    if (realUrl && !isIgnoredAncestor(img)) return true;
    return false;
  }

  function wakeAllLazyChapterImages() {
    let woken = 0;
    let loadingImgs = 0;
    const imgs = document.querySelectorAll('img');
    imgs.forEach((img) => {
      if (!img.isConnected || img.closest('.cb-layer-container')) return;
      if (!isLikelyChapterLazyImg(img)) return;

      const curSrc = img.currentSrc || img.src || '';
      const isPlaceholder =
        !curSrc ||
        curSrc.startsWith('data:image/svg') ||
        curSrc.startsWith('data:image/gif') ||
        /placeholder|blank|loading|spacer|1x1/i.test(curSrc) ||
        (img.complete && img.naturalWidth <= 10);

      const lazyUrl = extractLazyRealUrl(img);
      const lazySrcset = (img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || '').trim();

      if (img.loading === 'lazy') {
        img.loading = 'eager';
        woken++;
      }

      if (lazyUrl && (isPlaceholder || curSrc !== lazyUrl) && (!img.complete || img.naturalWidth <= 10)) {
        img.setAttribute('src', lazyUrl);
        if (lazySrcset) img.setAttribute('srcset', lazySrcset);
        delete img.dataset.cbObserved;
        woken++;
      }

      if (!img.complete || img.naturalWidth <= 10) {
        loadingImgs++;
        img.addEventListener(
          'load',
          () => {
            observeCandidate(img);
            if (state.fullChapterMode && isCandidateComicElement(img)) {
              enqueueTarget(img, { force: state.fullChapterForce });
            }
            updateFullChapterProgress();
            pumpAllWork();
          },
          { once: true }
        );
      } else {
        observeCandidate(img);
      }
    });
    return { woken, loadingImgs };
  }

  function ensureProgressBar() {
    if (window !== window.top) return null;
    if (state.progressEl && document.documentElement.contains(state.progressEl)) {
      return state.progressEl;
    }
    const bar = document.createElement('div');
    bar.id = 'cb-chapter-progress';

    const top = document.createElement('div');
    top.className = 'cb-prog-top';

    const text = document.createElement('span');
    text.className = 'cb-prog-text';

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'cb-prog-stop';
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopFullChapterTranslation('已手动停止全话翻译');
    });

    top.append(text, stopBtn);

    const track = document.createElement('div');
    track.className = 'cb-prog-track';
    const fill = document.createElement('div');
    fill.className = 'cb-prog-fill';
    track.appendChild(fill);

    bar.append(top, track);
    document.documentElement.appendChild(bar);
    state.progressEl = bar;
    return bar;
  }

  function stopFullChapterTranslation(toastMsg) {
    state.fullChapterMode = false;
    state.fullChapterForce = false;
    clearInterval(state.fullChapterTimer);
    state.fullChapterTimer = null;
    // 清空尚未开始的排队任务（正在进行的请求自然结束）
    state.queue = [];
    state.queuedSet.clear();
    if (state.progressEl) state.progressEl.classList.remove('cb-show');
    if (toastMsg) showToast(toastMsg);
  }

  function computeFullChapterStats() {
    const candidates = collectAllActiveCandidates();
    let totalUnits = 0;
    let doneUnits = 0;
    let bubblesTotal = 0;
    let pendingImages = 0;

    // 统计尚未加载完成的章节懒加载图
    document.querySelectorAll('img').forEach((img) => {
      if (!img.isConnected || img.closest('.cb-layer-container')) return;
      if (isLikelyChapterLazyImg(img) && (!img.complete || img.naturalWidth <= 10)) {
        pendingImages++;
      }
    });

    for (const el of candidates) {
      const rec = state.records.get(el);
      if (rec && rec.stripState) {
        totalUnits += rec.stripState.tiles.length;
        doneUnits += rec.stripState.doneSet.size;
        bubblesTotal += rec.bubbles.length;
      } else if (rec && (rec.status === 'done' || rec.status === 'error')) {
        totalUnits += 1;
        doneUnits += 1;
        bubblesTotal += rec.bubbles.length;
      } else {
        totalUnits += 1;
      }
    }

    totalUnits += pendingImages;
    const pct = totalUnits > 0 ? Math.min(100, Math.round((doneUnits / totalUnits) * 100)) : 0;
    return { totalUnits, doneUnits, pendingImages, bubblesTotal, pct, imageCount: candidates.length };
  }

  function updateFullChapterProgress() {
    if (!state.fullChapterMode) return;
    const st = computeFullChapterStats();
    const isFinished =
      st.totalUnits > 0 &&
      st.doneUnits >= st.totalUnits &&
      st.pendingImages === 0 &&
      state.activeRequests === 0 &&
      state.queue.length === 0;

    if (isFinished) {
      state.fullChapterMode = false;
      state.fullChapterForce = false;
      clearInterval(state.fullChapterTimer);
      state.fullChapterTimer = null;
      showToast(`全话翻译完成 · 共译 ${st.bubblesTotal} 处气泡`, 2400);
    }
  }

  function startFullChapterTranslation(force = false) {
    if (!Config.hasValidApiKey(state.settings)) {
      showToast('请先在插件配置中填入 VPS 地址或 API Key');
      return { ok: false, error: '未完成后端配置' };
    }

    state.fullChapterMode = true;
    state.fullChapterForce = Boolean(force);

    // 1. 唤醒整话所有 data-src / loading="lazy" 隐藏原图
    const { woken, loadingImgs } = wakeAllLazyChapterImages();

    // 2. 将当前已就绪的全部漫画图加入队列（仍按当前屏幕最高优先 + 整话向下顺序调度）
    const targets = collectAllActiveCandidates();
    targets.forEach((el) => {
      if (force) {
        const rec = state.records.get(el);
        if (rec) rec.stripState = null;
      }
      enqueueTarget(el, { force: Boolean(force) });
    });

    if (targets.length === 0 && loadingImgs === 0) {
      state.fullChapterMode = false;
      showToast('当前页未找到符合条件的漫画图片');
      return { ok: true, count: 0 };
    }

    updateFullChapterProgress();
    pumpAllWork();

    // 定时兜底检测延迟注入的章节图并刷新进度条
    clearInterval(state.fullChapterTimer);
    state.fullChapterTimer = setInterval(() => {
      if (!state.fullChapterMode) {
        clearInterval(state.fullChapterTimer);
        state.fullChapterTimer = null;
        return;
      }
      wakeAllLazyChapterImages();
      pumpAllWork();
      updateFullChapterProgress();
    }, 1000);

    const extra = woken > 0 ? `（已唤醒 ${woken} 张懒加载图）` : '';
    showToast(`开始全话翻译：共发现 ${targets.length + loadingImgs} 张画面${extra}`, 2800);
    return { ok: true, count: targets.length + loadingImgs, woken };
  }

  /**
   * 主动唤醒下方 3 张带 loading="lazy" 的条漫图片，避免浏览器拖到滑过去才下载原图
   */
  function nudgeUpcomingLazyWebtoonImages() {
    if (!Config.isSiteAutoEnabled(state.settings, location.hostname)) return;
    const imgs = Array.from(document.querySelectorAll('img')).filter(
      (img) => img.isConnected && (isWebtoonReaderImage(img) || img.getBoundingClientRect().width >= 380)
    );
    let nudged = 0;
    for (const img of imgs) {
      if (nudged >= 3) break;
      const r = img.getBoundingClientRect();
      // 仅预热视口附近及下方尚未加载完成的图片
      if (r.bottom < -200) continue;
      if (!img.complete || img.naturalWidth === 0) {
        if (img.loading === 'lazy') {
          img.loading = 'eager';
        }
        observeCandidate(img);
        nudged++;
      }
    }
  }

  function dispatchStripTile(rec, tile) {
    const st = rec.stripState;
    if (!st || st.doneSet.has(tile.index) || st.activeSet.has(tile.index)) return false;

    st.activeSet.add(tile.index);
    state.activeRequests++;
    rec.toolbar.classList.add('cb-status-loading', 'cb-toolbar-active');
    rec.label.textContent = `条漫 ${st.doneSet.size + 1}/${st.tiles.length}...`;

    (async () => {
      try {
        const encoded = ImgUtils.encodeStripTile(st.drawable, st.width, tile, state.settings.maxImageDimension);
        const res = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_VPS_IMAGE',
          dataUrl: encoded.dataUrl,
          pageTitle: document.title || '',
          pageUrl: location.href || '',
          force: Boolean(st.force)
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'VPS 分片失败');

        if (rec.stripState !== st) return; // 已被重译重置
        st.doneSet.add(tile.index);
        rec.bubbles = ImgUtils.mergeVpsTileBubbles(rec.bubbles, tile, res.bubbles || []);
        renderBubbles(rec);

        if (st.doneSet.size >= st.tiles.length) {
          rec.bubbles = rec.bubbles.map((b) => {
            const clean = Object.assign({}, b);
            delete clean._seamScore;
            return clean;
          });
          rec.stripState = null;
          rec.status = 'done';
          const key = getTargetIdentity(rec.el);
          if (state.settings.enableCache && key) {
            chrome.runtime.sendMessage({
              type: 'SAVE_CACHED_TRANSLATION',
              imageKey: key,
              bubbles: rec.bubbles
            });
          }
          updateToolbar(rec);
        } else if (st.activeSet.size <= 1) {
          rec.toolbar.classList.remove('cb-status-loading', 'cb-toolbar-active');
          rec.toolbar.classList.add('cb-status-done');
          rec.label.textContent = `已译 ${rec.bubbles.length} 处 (${st.doneSet.size}/${st.tiles.length})`;
          rec.toggleBtn.style.display = rec.bubbles.length > 0 ? '' : 'none';
          rec.exportBtn.style.display = rec.bubbles.length > 0 ? '' : 'none';
          updateRecordVisibility(rec);
        }
      } catch (err) {
        rec.errorMsg = err && err.message ? err.message : String(err);
        rec.label.textContent = rec.errorMsg;
      } finally {
        st.activeSet.delete(tile.index);
        state.activeRequests--;
        updateFullChapterProgress();
        pumpAllWork();
      }
    })();

    return true;
  }

  /**
   * 全局两级动态优先级 + 整话持续后台预翻调度器：
   * Tier 1: 当前屏幕内未翻的分片/图片（永远优先插队，距离屏幕中心最近优先）
   * Tier 2: 屏幕下方尚未翻的分片/图片（自上而下按阅读顺序持续后台预翻整话，滚下去直接秒出）
   * Tier 3: 屏幕上方漏翻的分片/图片
   */
  function pickNextPriorityWork() {
    const vh = window.innerHeight || 900;
    const viewTop = -vh * 0.25;
    const viewBottom = vh * 1.25;
    const viewCenter = vh * 0.5;

    function scoreSpan(top, bottom) {
      const mid = (top + bottom) * 0.5;
      if (bottom >= viewTop && top <= viewBottom) {
        // Tier 1: 当前视口内（最高优先级）
        return Math.abs(mid - viewCenter);
      }
      if (top > viewBottom) {
        // Tier 2: 当前视口下方（按阅读顺序从近到远持续预翻整话）
        return 100000 + (top - viewBottom);
      }
      // Tier 3: 视口上方（最低优先级）
      return 10000000 + (viewTop - bottom);
    }

    let best = null;
    const consider = (item, priority) => {
      if (!best || priority < best.priority) {
        best = { item, priority };
      }
    };

    // 1. 扫描所有已就绪超长条漫的未完成分片
    for (const rec of state.records.values()) {
      const st = rec.stripState;
      if (!st || !rec.el.isConnected) continue;
      const rect = rec.el.getBoundingClientRect();
      if (rect.height < 40) continue;
      for (const tile of st.tiles) {
        if (st.doneSet.has(tile.index) || st.activeSet.has(tile.index)) continue;
        const tTop = rect.top + (tile.offsetY / st.height) * rect.height;
        const tBottom = rect.top + ((tile.offsetY + tile.sliceH) / st.height) * rect.height;
        consider({ kind: 'stripTile', rec, tile }, scoreSpan(tTop, tBottom));
      }
    }

    // 2. 扫描手动/自动排队的整图任务
    for (let i = 0; i < state.queue.length; i++) {
      const task = state.queue[i];
      if (!task.el.isConnected) continue;
      const r = task.el.getBoundingClientRect();
      const baseScore = task.highPriority ? -500000 : scoreSpan(r.top, r.bottom);
      consider({ kind: 'queuedTask', task }, baseScore);
    }

    // 3. 自动翻译开启 或 全话强制模式 下，持续发现整话中尚未入队的漫画图自动推进！
    if (
      (state.fullChapterMode || Config.isSiteAutoEnabled(state.settings, location.hostname)) &&
      Config.hasValidApiKey(state.settings)
    ) {
      const allTargets = collectAllActiveCandidates();
      for (const el of allTargets) {
        if (state.queuedSet.has(el)) continue;
        const rec = state.records.get(el);
        const curSrc = getTargetIdentity(el);
        if (
          rec &&
          rec.src === curSrc &&
          (rec.status === 'done' || rec.status === 'loading' || rec.status === 'queued' || rec.status === 'streaming' || rec.status === 'error')
        ) {
          continue;
        }
        const r = el.getBoundingClientRect();
        // 普通自动模式不主动回头翻早已滚过的上方图；一键全话模式则覆盖整话 100% 画面
        if (!state.fullChapterMode && r.bottom < viewTop) continue;
        consider({ kind: 'prefetchEl', el }, scoreSpan(r.top, r.bottom) + 50);
      }
    }

    return best ? best.item : null;
  }

  function pumpAllWork() {
    if (!Config.hasValidApiKey(state.settings)) return;

    // 清理已从 DOM 移除的过期队列项
    state.queue = state.queue.filter((t) => {
      if (!t.el.isConnected) {
        state.queuedSet.delete(t.el);
        return false;
      }
      return true;
    });

    while (state.activeRequests < state.settings.maxConcurrency) {
      const work = pickNextPriorityWork();
      if (!work) {
        // 当前已加载图片均处理完，顺手唤醒下方几张 lazy 条漫图提前下载
        nudgeUpcomingLazyWebtoonImages();
        break;
      }

      if (work.kind === 'stripTile') {
        if (!dispatchStripTile(work.rec, work.tile)) break;
        continue;
      }

      if (work.kind === 'queuedTask') {
        const task = work.task;
        state.queue = state.queue.filter((t) => t !== task);
        state.queuedSet.delete(task.el);
        state.activeRequests++;
        processSingleTarget(task.el, task.force)
          .catch(() => {})
          .finally(() => {
            state.activeRequests--;
            updateFullChapterProgress();
            pumpAllWork();
          });
        continue;
      }

      if (work.kind === 'prefetchEl') {
        const el = work.el;
        nudgeUpcomingLazyWebtoonImages();
        state.activeRequests++;
        processSingleTarget(el, state.fullChapterForce)
          .catch(() => {})
          .finally(() => {
            state.activeRequests--;
            updateFullChapterProgress();
            pumpAllWork();
          });
      }
    }
  }

  async function processSingleTarget(el, force) {
    const rec = getOrCreateRecord(el);
    rec.src = getTargetIdentity(el);
    rec.status = 'loading';
    rec.errorMsg = '';
    updateToolbar(rec);

    try {
      if (!Config.hasValidApiKey(state.settings)) {
        throw new Error(
          state.settings.provider === 'vps'
            ? '请点击插件图标填写 VPS 地址'
            : '请先点击插件图标配置 API Key'
        );
      }

      const imageKey = getTargetIdentity(el);
      if (!force && state.settings.enableCache && imageKey) {
        const cacheRes = await chrome.runtime.sendMessage({
          type: 'GET_CACHED_TRANSLATION',
          imageKey
        });
        if (cacheRes && cacheRes.ok && cacheRes.hit && Array.isArray(cacheRes.bubbles)) {
          rec.bubbles = cacheRes.bubbles;
          rec.status = 'done';
          renderBubbles(rec);
          updateToolbar(rec);
          return;
        }
      }

      // 形态 B 条漫：若下方紧贴同宽短切片，自动拼带一次识别（防跨缝腰斩气泡）
      if (state.settings.provider === 'vps' && !force) {
        const group = findAdjacentWebtoonGroup(el);
        if (group.length >= 2) {
          await processStitchedWebtoonGroup(group, force);
          return;
        }
      }

      const { drawable, width, height } = await ImgUtils.acquireCleanDrawable(el);
      let merged = [];

      if (state.settings.provider === 'vps') {
        const isLongStrip = height / Math.max(1, width) > 2.3 && height > 2200;

        if (isLongStrip) {
          // 形态 A 条漫：切换为视口按需动态分片模式，立即释放主队列槽位并优先并发翻译当前屏！
          const tiles = ImgUtils.planVpsLongStripTiles(width, height);
          rec.bubbles = [];
          rec.stripState = {
            drawable,
            width,
            height,
            tiles,
            doneSet: new Set(),
            activeSet: new Set(),
            force: Boolean(force)
          };
          rec.status = 'streaming';
          setTimeout(() => pumpAllWork(), 0);
          return;
        } else {
          const encoded = ImgUtils.encodeDrawableForVps(drawable, width, height, state.settings.maxImageDimension);
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_VPS_IMAGE',
            dataUrl: encoded.dataUrl,
            pageTitle: document.title || '',
            pageUrl: location.href || '',
            force: Boolean(force)
          });
          if (!res || !res.ok) {
            throw new Error((res && res.error) || 'VPS 识别擦字失败');
          }
          merged = res.bubbles || [];
        }
      } else {
        const tiles = ImgUtils.buildImageTiles(drawable, width, height, state.settings.maxImageDimension);
        const tileResults = [];
        for (let i = 0; i < tiles.length; i++) {
          if (tiles.length > 1) rec.label.textContent = `识别长图 (${i + 1}/${tiles.length})...`;
          const tile = tiles[i];
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_IMAGE_TILE',
            dataUrl: tile.dataUrl,
            width: tile.width,
            height: tile.height
          });
          if (!res || !res.ok) throw new Error((res && res.error) || 'AI 识别翻译失败');
          tileResults.push({ tile, bubbles: res.bubbles || [] });
        }
        merged = tileResults.length === 1 ? tileResults[0].bubbles : ImgUtils.mergeTileBubbles(tileResults);
        if (state.settings.autoSampleBgColor && merged.length > 0) {
          merged = ImgUtils.sampleBubbleColors(drawable, width, height, merged);
        }
      }

      rec.bubbles = merged;
      rec.status = 'done';
      if (state.settings.enableCache && imageKey) {
        chrome.runtime.sendMessage({
          type: 'SAVE_CACHED_TRANSLATION',
          imageKey,
          bubbles: merged
        });
      }

      renderBubbles(rec);
      updateToolbar(rec);
    } catch (err) {
      rec.status = 'error';
      rec.errorMsg = err && err.message ? err.message : String(err);
      updateToolbar(rec);
    }
  }

  function pumpQueue() {
    pumpAllWork();
  }

  function enqueueTarget(el, options = {}) {
    const { force = false, highPriority = false } = options;
    if (!(el instanceof Element) || !el.isConnected) return;

    const currentSrc = getTargetIdentity(el);
    const existing = state.records.get(el);
    if (!force && existing) {
      if (existing.src === currentSrc && (existing.status === 'done' || existing.status === 'loading' || existing.status === 'queued' || existing.status === 'streaming')) {
        pumpAllWork();
        return;
      }
    }

    if (state.queuedSet.has(el)) {
      if (!force) return;
      state.queue = state.queue.filter((t) => t.el !== el);
      state.queuedSet.delete(el);
    }

    const rec = getOrCreateRecord(el);
    rec.status = 'queued';
    updateToolbar(rec);

    const task = { el, force, highPriority };
    if (highPriority) state.queue.unshift(task);
    else state.queue.push(task);
    state.queuedSet.add(el);
    pumpAllWork();
  }

  // -------------------- 自动扫描与动态追踪 --------------------

  function observeCandidate(el) {
    if (!(el instanceof Element) || el.closest('.cb-layer-container')) return;
    if (el.dataset && el.dataset.cbObserved === '1') return;

    const attach = () => {
      if (!el.isConnected) return;
      if (state.intersectionObserver) state.intersectionObserver.observe(el);
      // 懒加载图片一旦加载完成，立刻唤醒后台预翻调度器
      pumpAllWork();
    };

    if (el instanceof HTMLImageElement) {
      el.dataset.cbObserved = '1';
      if (el.complete && el.naturalWidth > 0) attach();
      else el.addEventListener('load', attach, { once: true });
      return;
    }

    if (el instanceof HTMLCanvasElement) {
      el.dataset.cbObserved = '1';
      attach();
      return;
    }

    if (el.tagName === 'DIV') {
      const bg = ImgUtils.extractBackgroundImageUrl(el);
      if (bg) {
        el.dataset.cbObserved = '1';
        attach();
      }
    }
  }

  function scanCandidates(rootNode = document) {
    if (!rootNode || !rootNode.querySelectorAll) return;
    rootNode.querySelectorAll('img, canvas, div[style*="background"]').forEach(observeCandidate);
  }

  function scanVisibleAndKickoff() {
    if (!Config.isSiteAutoEnabled(state.settings, location.hostname)) return;
    if (!Config.hasValidApiKey(state.settings)) return;
    scanCandidates(document);
    nudgeUpcomingLazyWebtoonImages();
    pumpAllWork();
  }

  function collectAllActiveCandidates() {
    const set = new Set();
    document.querySelectorAll('img, canvas, div').forEach((el) => {
      if (isCandidateComicElement(el)) set.add(el);
    });
    return Array.from(set);
  }

  function startObservers() {
    if (!state.intersectionObserver) {
      state.intersectionObserver = new IntersectionObserver(
        (entries) => {
          if (!Config.isSiteAutoEnabled(state.settings, location.hostname)) return;
          if (!Config.hasValidApiKey(state.settings)) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (isCandidateComicElement(entry.target)) {
              enqueueTarget(entry.target, { force: false });
            }
          }
        },
        { rootMargin: '800px 0px 1800px 0px', threshold: 0.02 }
      );
    }

    if (!state.resizeObserver) {
      state.resizeObserver = new ResizeObserver(() => scheduleLayoutSync());
    }

    if (!state.mutationObserver) {
      state.mutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            m.addedNodes.forEach((node) => {
              if (node instanceof Element) {
                observeCandidate(node);
                scanCandidates(node);
              }
            });
            m.removedNodes.forEach((node) => {
              if (node instanceof Element && state.records.has(node)) {
                cleanupRecord(node);
              }
            });
          } else if (m.type === 'attributes' && m.target instanceof Element) {
            const el = m.target;
            const rec = state.records.get(el);
            const newSrc = getTargetIdentity(el);
            if (rec && rec.src && newSrc && rec.src !== newSrc) {
              rec.status = 'idle';
              rec.bubbles = [];
              rec.bubblesEl.textContent = '';
            }
            if (el instanceof HTMLImageElement || el.tagName === 'DIV') {
              delete el.dataset.cbObserved;
              if (state.intersectionObserver) state.intersectionObserver.unobserve(el);
              observeCandidate(el);
            }
          }
        }
      });

      state.mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'style', 'class', 'width', 'height']
      });
    }

    scanCandidates(document);
    // 首屏与延迟加载漫画兜底触发（覆盖 CSS class 背景图和异步解码的 Canvas/Img）
    scanVisibleAndKickoff();
    setTimeout(scanVisibleAndKickoff, 1200);
    setTimeout(scanVisibleAndKickoff, 3200);
  }

  // -------------------- 交互监听与消息通道 --------------------

  document.addEventListener(
    'contextmenu',
    (e) => {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      const found = stack.find(
        (el) =>
          el instanceof HTMLImageElement ||
          el instanceof HTMLCanvasElement ||
          (el.tagName === 'DIV' && ImgUtils.extractBackgroundImageUrl(el))
      );
      if (found) {
        state.lastRightClickedTarget = found;
        state.lastRightClickTs = Date.now();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 't') {
        e.preventDefault();
        state.overlayVisible = !state.overlayVisible;
        for (const rec of state.records.values()) {
          rec.localHidden = false;
          updateRecordVisibility(rec);
        }
        showToast(state.overlayVisible ? '已显示漫画中文译文 (Alt+T)' : '已隐藏译文，显示英文原图 (Alt+T)');
      } else if (k === 'a') {
        e.preventDefault();
        startFullChapterTranslation(false);
      }
    }
  });

  window.addEventListener('resize', scheduleLayoutSync, { passive: true });
  window.addEventListener('scroll', scheduleLayoutSync, { passive: true, capture: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleLayoutSync, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleLayoutSync, { passive: true });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[Config.STORAGE_KEY]) return;
    state.settings = Config.mergeSettings(changes[Config.STORAGE_KEY].newValue);
    state.overlayVisible = state.settings.overlayVisible;

    for (const rec of state.records.values()) {
      updateRecordVisibility(rec);
      if (rec.status === 'done' && rec.bubbles.length > 0) renderBubbles(rec);
    }

    if (Config.isSiteAutoEnabled(state.settings, location.hostname) && Config.hasValidApiKey(state.settings)) {
      collectAllActiveCandidates().forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom >= -400 && r.top <= window.innerHeight + 600) {
          enqueueTarget(el, { force: false });
        }
      });
    }
  });

  function getPageStats() {
    let done = 0, loading = 0, queued = 0, errors = 0, bubblesTotal = 0;
    for (const rec of state.records.values()) {
      if (rec.status === 'done') { done++; bubblesTotal += rec.bubbles.length; }
      else if (rec.status === 'loading') loading++;
      else if (rec.status === 'queued') queued++;
      else if (rec.status === 'error') errors++;
    }
    return { hostname: location.hostname, done, loading, queued, errors, bubblesTotal, overlayVisible: state.overlayVisible };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'GET_PAGE_STATUS') {
      sendResponse({ ok: true, stats: getPageStats() });
      return false;
    }

    if (message.type === 'TRANSLATE_PAGE' || message.type === 'TRANSLATE_FULL_CHAPTER') {
      const res = startFullChapterTranslation(Boolean(message.force));
      sendResponse(res);
      return false;
    }

    if (message.type === 'STOP_FULL_CHAPTER') {
      stopFullChapterTranslation('已停止全话翻译');
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'TRANSLATE_SINGLE_IMAGE') {
      let target = null;
      if (state.lastRightClickedTarget && Date.now() - state.lastRightClickTs < 15000 && state.lastRightClickedTarget.isConnected) {
        target = state.lastRightClickedTarget;
      }
      if (!target && message.srcUrl) {
        target = Array.from(document.querySelectorAll('img')).find(
          (img) => img.currentSrc === message.srcUrl || img.src === message.srcUrl
        );
      }
      if (!target) {
        showToast('未在右键位置找到漫画图片或 Canvas');
        sendResponse({ ok: false, error: '未定位到漫画元素' });
        return false;
      }
      if (!Config.hasValidApiKey(state.settings)) {
        showToast('请先点击插件图标填写 VPS 地址或 API Key');
        sendResponse({ ok: false, error: '未完成后端配置' });
        return false;
      }
      enqueueTarget(target, { force: true, highPriority: true });
      showToast('已开始无痕擦字并翻译选中画面');
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'TOGGLE_OVERLAY') {
      state.overlayVisible = typeof message.visible === 'boolean' ? message.visible : !state.overlayVisible;
      for (const rec of state.records.values()) {
        rec.localHidden = false;
        updateRecordVisibility(rec);
      }
      sendResponse({ ok: true, overlayVisible: state.overlayVisible });
      return false;
    }

    if (message.type === 'EXPORT_ALL_TRANSLATED') {
      const doneRecs = Array.from(state.records.values()).filter(
        (r) => r.status === 'done' && r.bubbles.length > 0 && r.el.isConnected
      );
      if (doneRecs.length === 0) {
        showToast('本页暂无已翻译完成的画面可导出');
        sendResponse({ ok: false, error: '暂无可导出画面' });
        return false;
      }
      (async () => {
        showToast(`正在批量导出 ${doneRecs.length} 张高清译后图...`, 3500);
        for (let i = 0; i < doneRecs.length; i++) {
          const r = doneRecs[i];
          await ImgUtils.renderAndDownloadTranslatedImage(r.el, r.bubbles, state.settings, `${guessFilename(r.el)}_${i + 1}`);
          await new Promise((res) => setTimeout(res, 250));
        }
        showToast(`已完成 ${doneRecs.length} 张译后图导出`);
        sendResponse({ ok: true, count: doneRecs.length });
      })().catch((err) => {
        showToast(`批量导出失败: ${err.message || err}`);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
      return true;
    }

    return false;
  });

  async function init() {
    state.settings = await Config.loadSettings();
    state.overlayVisible = state.settings.overlayVisible;
    startObservers();
  }

  init();
})();
