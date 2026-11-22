(function (root) {
  'use strict';

  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('加载图片数据失败'));
      img.src = dataUrl;
    });
  }

  function extractBackgroundImageUrl(el) {
    if (!(el instanceof Element)) return '';
    const bg = window.getComputedStyle(el).backgroundImage || '';
    const match = /url\((['"]?)(.*?)\1\)/i.exec(bg);
    const url = match && match[2] ? match[2].trim() : '';
    if (!url || url === 'none' || url.startsWith('data:image/svg+xml') || /\.svg(\?|$)/i.test(url)) {
      return '';
    }
    return url;
  }

  /**
   * 视口截屏兜底抓图（用于 DRM / 污染 Canvas / 极端反爬漫画站）
   */
  async function captureElementViaScreenshot(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) {
      throw new Error('目标漫画区域不可见，无法截屏捕获');
    }

    // 临时隐藏插件自身的覆盖层，避免把译文或工具条截进去
    const hiddenNodes = [];
    document.querySelectorAll('.cb-layer-container, #cb-tooltip, #cb-toast').forEach((node) => {
      if (node.style.visibility !== 'hidden') {
        hiddenNodes.push(node);
        node.style.visibility = 'hidden';
      }
    });

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let shotRes;
    try {
      shotRes = await chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' });
    } finally {
      hiddenNodes.forEach((node) => {
        node.style.visibility = '';
      });
    }

    if (!shotRes || !shotRes.ok || !shotRes.dataUrl) {
      throw new Error((shotRes && shotRes.error) || '截屏捕获失败');
    }

    const shotImg = await loadImageFromDataUrl(shotRes.dataUrl);
    const dpr = shotImg.naturalWidth / Math.max(1, window.innerWidth);

    const sx = Math.max(0, Math.round(rect.left * dpr));
    const sy = Math.max(0, Math.round(rect.top * dpr));
    const sw = Math.min(shotImg.naturalWidth - sx, Math.round(rect.width * dpr));
    const sh = Math.min(shotImg.naturalHeight - sy, Math.round(rect.height * dpr));
    if (sw < 20 || sh < 20) {
      throw new Error('元素超出当前可视区域，请滚动到画面内重试');
    }

    const crop = document.createElement('canvas');
    crop.width = sw;
    crop.height = sh;
    crop.getContext('2d').drawImage(shotImg, sx, sy, sw, sh, 0, 0, sw, sh);
    return {
      drawable: crop,
      width: sw,
      height: sh,
      src: `screenshot_${sw}x${sh}`
    };
  }

  /**
   * 全载体无污染图片获取：支持 <img>、<canvas>、CSS background-image <div>
   * 链路：本地快速通道 -> Background DNR(Referer+Cookie) fetch_as_page -> 截屏兜底
   */
  async function acquireCleanDrawable(el) {
    // 1. <canvas> 漫画载体（常见于防盗链拼图站）
    if (el instanceof HTMLCanvasElement) {
      const w = el.width || Math.round(el.getBoundingClientRect().width);
      const h = el.height || Math.round(el.getBoundingClientRect().height);
      if (!w || !h) throw new Error('Canvas 尺寸为空');
      try {
        const probe = document.createElement('canvas');
        probe.width = 2;
        probe.height = 2;
        const pctx = probe.getContext('2d', { willReadFrequently: true });
        pctx.drawImage(el, 0, 0, 2, 2);
        pctx.getImageData(0, 0, 1, 1);
        return { drawable: el, width: w, height: h, src: `canvas_${w}x${h}` };
      } catch (_) {
        return captureElementViaScreenshot(el);
      }
    }

    // 2. CSS background-image <div> 载体
    if (!(el instanceof HTMLImageElement)) {
      const bgUrl = extractBackgroundImageUrl(el);
      if (!bgUrl) throw new Error('元素不包含有效漫画图片');
      try {
        const res = await chrome.runtime.sendMessage({ type: 'FETCH_AS_PAGE', url: bgUrl });
        if (res && res.ok && res.dataUrl) {
          const cleanImg = await loadImageFromDataUrl(res.dataUrl);
          return {
            drawable: cleanImg,
            width: cleanImg.naturalWidth,
            height: cleanImg.naturalHeight,
            src: bgUrl
          };
        }
      } catch (_) {}
      return captureElementViaScreenshot(el);
    }

    // 3. 标准 <img> 载体
    const src = el.currentSrc || el.src;
    if (!src) throw new Error('图片地址为空');
    const natW = el.naturalWidth || el.width;
    const natH = el.naturalHeight || el.height;
    if (!natW || !natH) throw new Error('图片尚未加载完成');

    try {
      const probe = document.createElement('canvas');
      probe.width = 2;
      probe.height = 2;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(el, 0, 0, 2, 2);
      pctx.getImageData(0, 0, 1, 1);
      return { drawable: el, width: natW, height: natH, src };
    } catch (_) {
      // 跨域污染 -> 走 DNR Referer+Cookie 抓图
    }

    if (src.startsWith('blob:') || src.startsWith('data:')) {
      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('读取 Blob 图片失败'));
          reader.readAsDataURL(blob);
        });
        const cleanImg = await loadImageFromDataUrl(dataUrl);
        return { drawable: cleanImg, width: cleanImg.naturalWidth || natW, height: cleanImg.naturalHeight || natH, src };
      } catch (_) {
        return captureElementViaScreenshot(el);
      }
    }

    try {
      const res = await chrome.runtime.sendMessage({ type: 'FETCH_AS_PAGE', url: src });
      if (res && res.ok && res.dataUrl) {
        const cleanImg = await loadImageFromDataUrl(res.dataUrl);
        return {
          drawable: cleanImg,
          width: cleanImg.naturalWidth || natW,
          height: cleanImg.naturalHeight || natH,
          src
        };
      }
    } catch (_) {}

    // 终极兜底：视口截屏裁剪
    return captureElementViaScreenshot(el);
  }

  /**
   * 为自建 VPS 打包单图上传（1024px 宽对英文漫极清晰，上传快、VPS OCR 提速 40%）
   */
  function encodeDrawableForVps(drawable, width, height, maxWidth) {
    const limitW = Math.max(760, Math.min(1024, maxWidth || 1024));
    const scale = width > limitW ? limitW / width : 1;
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(drawable, 0, 0, width, height, 0, 0, tw, th);
    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.84),
      width: tw,
      height: th
    };
  }

  /**
   * 形态 A 条漫（单张超长竖图）：0ms 规划虚拟分片坐标（约 2.15×宽、14% 重叠，减少近一半切片数）
   * 真正发送前再按需编码当前视口可见的切片，绝不阻塞
   */
  function planVpsLongStripTiles(width, height) {
    const idealSliceH = Math.max(1450, Math.round(width * 2.15));
    const overlap = Math.round(idealSliceH * 0.14);
    const step = Math.max(500, idealSliceH - overlap);
    const tiles = [];

    for (let y = 0; y < height && tiles.length < 30; y += step) {
      let sliceH = Math.min(idealSliceH, height - y);
      if (height - (y + sliceH) < 320) {
        sliceH = height - y;
      }
      const isBottomEdge = y + sliceH >= height;
      tiles.push({
        index: tiles.length,
        offsetY: y,
        sliceH,
        fullHeight: height,
        isTopEdge: y === 0,
        isBottomEdge
      });
      if (isBottomEdge) break;
    }
    return tiles;
  }

  function encodeStripTile(drawable, width, tile, maxWidth) {
    const limitW = Math.max(760, Math.min(1024, maxWidth || 1024));
    const scale = width > limitW ? limitW / width : 1;
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(tile.sliceH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(drawable, 0, tile.offsetY, width, tile.sliceH, 0, 0, tw, th);
    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.84),
      width: tw,
      height: th
    };
  }

  /**
   * 将超长条漫单个分片返回的气泡增量合并进整图气泡列表（高精度浮点 + 接缝安全分 IoU 去重）
   */
  function mergeVpsTileBubbles(existingBubbles, tile, tileBubbles) {
    const mapY = (v) => Number((((tile.offsetY + (v / 1000) * tile.sliceH) / tile.fullHeight) * 1000).toFixed(3));
    const fontScale = tile.sliceH / Math.max(1, tile.fullHeight);

    const incoming = (tileBubbles || []).map((b) => {
      let seamScore = 1000;
      if (!tile.isTopEdge) seamScore = Math.min(seamScore, b.y1);
      if (!tile.isBottomEdge) seamScore = Math.min(seamScore, 1000 - b.y2);

      return Object.assign({}, b, {
        y1: Math.max(0, Math.min(1000, mapY(b.y1))),
        y2: Math.max(0, Math.min(1000, mapY(b.y2))),
        ty1: Math.max(0, Math.min(1000, mapY(b.ty1 !== undefined ? b.ty1 : b.y1))),
        ty2: Math.max(0, Math.min(1000, mapY(b.ty2 !== undefined ? b.ty2 : b.y2))),
        origFontRatio: b.origFontRatio ? Number((b.origFontRatio * fontScale).toFixed(6)) : 0,
        _seamScore: seamScore
      });
    });

    const combined = [...(existingBubbles || []), ...incoming];
    combined.sort((a, b) => (b._seamScore ?? 500) - (a._seamScore ?? 500));

    const kept = [];
    for (const cand of combined) {
      let dup = false;
      for (const ex of kept) {
        const ix1 = Math.max(cand.x1, ex.x1), iy1 = Math.max(cand.y1, ex.y1);
        const ix2 = Math.min(cand.x2, ex.x2), iy2 = Math.min(cand.y2, ex.y2);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        if (inter <= 0) continue;
        const areaA = Math.max(0.01, (cand.x2 - cand.x1) * (cand.y2 - cand.y1));
        const areaB = Math.max(0.01, (ex.x2 - ex.x1) * (ex.y2 - ex.y1));
        if (inter / (areaA + areaB - inter) > 0.28 || inter / Math.min(areaA, areaB) > 0.58) {
          dup = true;
          break;
        }
      }
      if (!dup) kept.push(cand);
    }

    kept.sort((a, b) => (Math.abs(a.y1 - b.y1) > 15 ? a.y1 - b.y1 : a.x1 - b.x1));
    return kept;
  }

  /**
   * 形态 B 条漫（多张紧贴碎图）：纵向无缝拼合成单条完整画带，避免气泡在图缝处被腰斩
   */
  function stitchDrawablesVertically(items, maxWidth) {
    const limitW = Math.max(800, Math.min(1280, maxWidth || 1280));
    const maxItemW = Math.max(...items.map((it) => it.width));
    const targetW = Math.min(limitW, maxItemW);

    const segments = [];
    let totalH = 0;
    for (const it of items) {
      const scaledH = Math.max(1, Math.round((it.height / Math.max(1, it.width)) * targetW));
      segments.push({
        el: it.el,
        yStart: totalH,
        yEnd: totalH + scaledH,
        height: scaledH
      });
      totalH += scaledH;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, targetW, totalH);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const seg = segments[i];
      ctx.drawImage(it.drawable, 0, 0, it.width, it.height, 0, seg.yStart, targetW, seg.height);
    }

    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.85),
      width: targetW,
      height: totalH,
      segments
    };
  }

  /**
   * 将合带识别返回的气泡映射回各碎图（跨图缝气泡挂在上图并标记 crossSeam 跨缝无裁切渲染）
   */
  function splitStitchedBubbles(stitched, combinedBubbles) {
    const perSeg = stitched.segments.map(() => []);
    const totalH = Math.max(1, stitched.height);

    for (const b of combinedBubbles || []) {
      const by1 = (b.y1 / 1000) * totalH;
      const by2 = (b.y2 / 1000) * totalH;
      const bty1 = ((b.ty1 !== undefined ? b.ty1 : b.y1) / 1000) * totalH;
      const bty2 = ((b.ty2 !== undefined ? b.ty2 : b.y2) / 1000) * totalH;

      // 找到气泡顶部所在的切片（跨缝气泡自动归属上图，向下无缝延伸跨过接缝）
      let ownerIdx = stitched.segments.findIndex((seg) => by1 >= seg.yStart - 2 && by1 < seg.yEnd);
      if (ownerIdx === -1) {
        const cy = (by1 + by2) * 0.5;
        ownerIdx = stitched.segments.findIndex((seg) => cy >= seg.yStart && cy <= seg.yEnd);
      }
      if (ownerIdx === -1) ownerIdx = stitched.segments.length - 1;

      const seg = stitched.segments[ownerIdx];
      const segH = Math.max(1, seg.height);
      const toRel = (py) => Number((((py - seg.yStart) / segH) * 1000).toFixed(3));
      const crossSeam = by2 > seg.yEnd + 2 || bty2 > seg.yEnd + 2;

      perSeg[ownerIdx].push(
        Object.assign({}, b, {
          y1: toRel(by1),
          y2: toRel(by2),
          ty1: toRel(bty1),
          ty2: toRel(bty2),
          origFontRatio: b.origFontRatio ? Number((b.origFontRatio * (totalH / segH)).toFixed(6)) : 0,
          crossSeam
        })
      );
    }

    return perSeg;
  }

  /**
   * 为直连 VLM 准备图片切片（普通图缩放，竖版长条漫重叠切片）
   */
  function buildImageTiles(drawable, width, height, maxDim) {
    const limit = Math.max(640, maxDim || 1536);
    const isLongStrip = height / width > 2.4 && height > 1800;

    if (!isLongStrip) {
      const scale = Math.min(1, limit / Math.max(width, height));
      const tw = Math.max(1, Math.round(width * scale));
      const th = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(drawable, 0, 0, width, height, 0, 0, tw, th);
      return [{ dataUrl: canvas.toDataURL('image/jpeg', 0.88), width: tw, height: th, offsetY: 0, sliceH: height, fullHeight: height, isTopEdge: true, isBottomEdge: true }];
    }

    const maxTiles = 8;
    const idealSliceH = Math.round(width * 1.55);
    const overlap = Math.round(idealSliceH * 0.18);
    const step = Math.max(300, idealSliceH - overlap);
    const tiles = [];

    for (let y = 0; y < height && tiles.length < maxTiles; y += step) {
      let sliceH = Math.min(idealSliceH, height - y);
      if (tiles.length === maxTiles - 1 || y + sliceH >= height - 120) sliceH = height - y;
      const scale = Math.min(1, limit / Math.max(width, sliceH));
      const tw = Math.max(1, Math.round(width * scale));
      const th = Math.max(1, Math.round(sliceH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(drawable, 0, y, width, sliceH, 0, 0, tw, th);
      const isBottomEdge = y + sliceH >= height;
      tiles.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.86), width: tw, height: th, offsetY: y, sliceH, fullHeight: height, isTopEdge: y === 0, isBottomEdge });
      if (isBottomEdge) break;
    }
    return tiles;
  }

  function mergeTileBubbles(tileResults) {
    const all = [];
    for (const { tile, bubbles } of tileResults) {
      for (const b of bubbles) {
        const y1 = Math.round(((tile.offsetY + (b.y1 / 1000) * tile.sliceH) / tile.fullHeight) * 1000);
        const y2 = Math.round(((tile.offsetY + (b.y2 / 1000) * tile.sliceH) / tile.fullHeight) * 1000);
        let seamScore = 1000;
        if (!tile.isTopEdge) seamScore = Math.min(seamScore, b.y1);
        if (!tile.isBottomEdge) seamScore = Math.min(seamScore, 1000 - b.y2);
        all.push(Object.assign({}, b, { y1: Math.max(0, Math.min(1000, y1)), y2: Math.max(0, Math.min(1000, y2)), _seamScore: seamScore }));
      }
    }
    all.sort((a, b) => b._seamScore - a._seamScore);
    const kept = [];
    for (const cand of all) {
      let duplicate = false;
      for (const ex of kept) {
        const ix1 = Math.max(cand.x1, ex.x1), iy1 = Math.max(cand.y1, ex.y1);
        const ix2 = Math.min(cand.x2, ex.x2), iy2 = Math.min(cand.y2, ex.y2);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        if (inter <= 0) continue;
        const areaA = Math.max(1, (cand.x2 - cand.x1) * (cand.y2 - cand.y1));
        const areaB = Math.max(1, (ex.x2 - ex.x1) * (ex.y2 - ex.y1));
        if (inter / (areaA + areaB - inter) > 0.32 || inter / Math.min(areaA, areaB) > 0.6) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        const clean = Object.assign({}, cand);
        delete clean._seamScore;
        kept.push(clean);
      }
    }
    kept.sort((a, b) => (Math.abs(a.y1 - b.y1) > 35 ? a.y1 - b.y1 : a.x1 - b.x1));
    return kept;
  }

  function sampleBubbleColors(drawable, width, height, bubbles) {
    if (!bubbles || bubbles.length === 0) return bubbles;
    const maxSampleDim = 900;
    const scale = Math.min(1, maxSampleDim / Math.max(width, height));
    const sw = Math.max(1, Math.round(width * scale));
    const sh = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(drawable, 0, 0, sw, sh);
    let imgData;
    try {
      imgData = ctx.getImageData(0, 0, sw, sh).data;
    } catch (_) {
      return bubbles;
    }

    const readRgb = (px, py) => {
      const cx = Math.max(0, Math.min(sw - 1, Math.round(px)));
      const cy = Math.max(0, Math.min(sh - 1, Math.round(py)));
      const idx = (cy * sw + cx) * 4;
      return [imgData[idx], imgData[idx + 1], imgData[idx + 2]];
    };

    return bubbles.map((b) => {
      if (b.inpaintingDataUrl) return b; // VPS 已精确采样与擦字，直接保留
      const rx1 = (b.x1 / 1000) * sw, ry1 = (b.y1 / 1000) * sh;
      const rx2 = (b.x2 / 1000) * sw, ry2 = (b.y2 / 1000) * sh;
      const rw = rx2 - rx1, rh = ry2 - ry1;
      if (rw < 4 || rh < 4) return b;
      const samples = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        samples.push(readRgb(rx1 + rw * t, ry1 + 1), readRgb(rx1 + rw * t, ry2 - 1), readRgb(rx1 + 1, ry1 + rh * t), readRgb(rx2 - 1, ry1 + rh * t));
      }
      const withLum = samples.map(([r, g, bVal]) => ({ r, g, b: bVal, lum: 0.299 * r + 0.587 * g + 0.114 * bVal })).sort((a, x) => a.lum - x.lum);
      const med = withLum[Math.floor(withLum.length * 0.5)].lum;
      const slice = med >= 130
        ? withLum.slice(Math.floor(withLum.length * 0.58), Math.max(1, Math.floor(withLum.length * 0.88)))
        : withLum.slice(Math.floor(withLum.length * 0.12), Math.max(1, Math.floor(withLum.length * 0.42)));
      const avg = slice.reduce((acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }), { r: 0, g: 0, b: 0 });
      const r = Math.round(avg.r / slice.length), g = Math.round(avg.g / slice.length), bl = Math.round(avg.b / slice.length);
      const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
      return Object.assign({}, b, { bgColor: `rgb(${r}, ${g}, ${bl})`, textColor: lum > 142 ? '#141414' : '#FAFAFA' });
    });
  }

  /**
   * 精确计算 <img> / <canvas> / background-image <div> 实际绘制内容矩形
   */
  function getRenderedTargetBox(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const padL = parseFloat(style.paddingLeft) || 0, padR = parseFloat(style.paddingRight) || 0;
    const padT = parseFloat(style.paddingTop) || 0, padB = parseFloat(style.paddingBottom) || 0;
    const borL = parseFloat(style.borderLeftWidth) || 0, borR = parseFloat(style.borderRightWidth) || 0;
    const borT = parseFloat(style.borderTopWidth) || 0, borB = parseFloat(style.borderBottomWidth) || 0;

    const contentLeft = rect.left + borL + padL;
    const contentTop = rect.top + borT + padT;
    const contentW = Math.max(0, rect.width - borL - borR - padL - padR);
    const contentH = Math.max(0, rect.height - borT - borB - padT - padB);

    if (!(el instanceof HTMLImageElement)) {
      return { left: contentLeft, top: contentTop, width: contentW, height: contentH };
    }

    const natW = el.naturalWidth, natH = el.naturalHeight;
    const objectFit = style.objectFit || 'fill';
    if (!natW || !natH || !contentW || !contentH || objectFit === 'fill') {
      return { left: contentLeft, top: contentTop, width: contentW, height: contentH };
    }

    const natRatio = natW / natH;
    const boxRatio = contentW / contentH;
    let drawW = contentW, drawH = contentH;

    if (objectFit === 'contain' || objectFit === 'scale-down') {
      if (natRatio > boxRatio) {
        drawW = contentW; drawH = contentW / natRatio;
      } else {
        drawH = contentH; drawW = contentH * natRatio;
      }
      if (objectFit === 'scale-down' && drawW > natW && drawH > natH) {
        drawW = natW; drawH = natH;
      }
    } else if (objectFit === 'cover') {
      if (natRatio > boxRatio) {
        drawH = contentH; drawW = contentH * natRatio;
      } else {
        drawW = contentW; drawH = contentW / natRatio;
      }
    } else if (objectFit === 'none') {
      drawW = natW; drawH = natH;
    }

    return {
      left: contentLeft + (contentW - drawW) / 2,
      top: contentTop + (contentH - drawH) / 2,
      width: drawW,
      height: drawH
    };
  }

  // -------------------- 高清 Canvas 译后图导出引擎（支持无痕贴片直绘！） --------------------

  const NO_LINE_START = /^[，。！？、；：）》」』】\.\,\!\?\;\:\)\]\}]/;

  function wrapChineseText(ctx, text, maxWidth) {
    const paragraphs = String(text || '').split(/\r?\n/);
    const lines = [];
    for (const para of paragraphs) {
      if (!para.trim()) { lines.push(''); continue; }
      const tokens = para.match(/[A-Za-z0-9_'\-]+|\s+|./gu) || [];
      let current = '';
      for (const token of tokens) {
        const candidate = current + token;
        if (!current) { current = token.trimStart(); continue; }
        if (ctx.measureText(candidate).width <= maxWidth) {
          current = candidate;
        } else if (NO_LINE_START.test(token) && ctx.measureText(candidate).width <= maxWidth * 1.12) {
          current = candidate;
        } else {
          lines.push(current.trimEnd());
          current = token.trimStart();
        }
      }
      if (current) lines.push(current.trimEnd());
    }
    return lines.length > 0 ? lines : [''];
  }

  function drawRoundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  async function renderAndDownloadTranslatedImage(el, bubbles, settings, filenameHint) {
    const { drawable, width, height } = await acquireCleanDrawable(el);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(drawable, 0, 0, width, height);

    const fontFamily = (settings && settings.fontFamily) || '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
    const fontWeight = (settings && settings.fontWeight) || '600';

    for (const bubble of bubbles || []) {
      const bx1 = (bubble.x1 / 1000) * width;
      const by1 = (bubble.y1 / 1000) * height;
      const bw = Math.max(8, ((bubble.x2 - bubble.x1) / 1000) * width);
      const bh = Math.max(8, ((bubble.y2 - bubble.y1) / 1000) * height);

      // 优先贴入 VPS 返回的像素级无痕擦字贴片！
      if (bubble.inpaintingDataUrl) {
        try {
          const patchImg = await loadImageFromDataUrl(bubble.inpaintingDataUrl);
          ctx.drawImage(patchImg, bx1, by1, bw, bh);
        } catch (_) {
          ctx.fillStyle = bubble.bgColor || '#FFFFFF';
          ctx.fillRect(bx1, by1, bw, bh);
        }
      } else {
        const padX = Math.min(10, bw * 0.04);
        const padY = Math.min(10, bh * 0.04);
        const fx = Math.max(0, bx1 - padX), fy = Math.max(0, by1 - padY);
        const fw = Math.min(width - fx, bw + padX * 2), fh = Math.min(height - fy, bh + padY * 2);
        const bgColor = bubble.bgColor || '#FFFFFF';
        ctx.save();
        ctx.fillStyle = bgColor;
        ctx.shadowColor = bgColor;
        ctx.shadowBlur = Math.max(3, Math.min(12, Math.min(fw, fh) * 0.08));
        drawRoundedRectPath(ctx, fx, fy, fw, fh, bubble.shape === 'rect' ? Math.min(10, Math.min(fw, fh) * 0.14) : Math.min(fw, fh) * 0.42);
        ctx.fill();
        ctx.restore();
      }

      // 使用原英文行高比例作为字号基准，在安全气泡内部框中二分适配
      const tx1 = ((bubble.tx1 !== undefined ? bubble.tx1 : bubble.x1) / 1000) * width;
      const ty1 = ((bubble.ty1 !== undefined ? bubble.ty1 : bubble.y1) / 1000) * height;
      const tw = Math.max(12, (((bubble.tx2 !== undefined ? bubble.tx2 : bubble.x2) - (bubble.tx1 !== undefined ? bubble.tx1 : bubble.x1)) / 1000) * width);
      const th = Math.max(12, (((bubble.ty2 !== undefined ? bubble.ty2 : bubble.y2) - (bubble.ty1 !== undefined ? bubble.ty1 : bubble.y1)) / 1000) * height);

      const innerW = Math.max(12, tw * 0.94);
      const innerH = Math.max(12, th * 0.94);
      const detectedPx = bubble.origFontRatio > 0 ? Math.round(bubble.origFontRatio * height * 1.08) : 0;
      let lo = Math.max(10, Math.round(Math.min(width, height) * 0.011));
      let hi = detectedPx > 0
        ? Math.max(lo + 2, Math.min(72, Math.round(detectedPx * 1.18)))
        : Math.max(lo + 4, Math.min(72, Math.round(Math.min(innerW, innerH) * 0.65)));
      let bestSize = lo;
      let bestLines = [bubble.translation];

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        ctx.font = `${fontWeight} ${mid}px ${fontFamily}`;
        const lines = wrapChineseText(ctx, bubble.translation, innerW);
        const totalH = lines.length * mid * 1.24;
        const widest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
        if (totalH <= innerH && widest <= innerW * 1.04) {
          bestSize = mid;
          bestLines = lines;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      ctx.save();
      ctx.font = `${fontWeight} ${bestSize}px ${fontFamily}`;
      ctx.fillStyle = bubble.textColor || '#141414';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lineHeight = bestSize * 1.24;
      const startY = ty1 + th / 2 - (bestLines.length * lineHeight) / 2 + lineHeight / 2;
      const centerX = tx1 + tw / 2;
      for (let i = 0; i < bestLines.length; i++) {
        ctx.fillText(bestLines[i], centerX, startY + i * lineHeight);
      }
      ctx.restore();
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('生成导出图片失败');
    const safeName = (filenameHint || 'comic-page').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 48);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}-zh.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  root.ComicBubbleImageUtils = {
    extractBackgroundImageUrl,
    acquireCleanDrawable,
    encodeDrawableForVps,
    planVpsLongStripTiles,
    encodeStripTile,
    mergeVpsTileBubbles,
    stitchDrawablesVertically,
    splitStitchedBubbles,
    buildImageTiles,
    mergeTileBubbles,
    sampleBubbleColors,
    getRenderedTargetBox,
    renderAndDownloadTranslatedImage
  };
})(globalThis);
