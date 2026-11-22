import base64
import io
import math
import re
import threading
from dataclasses import dataclass
from typing import List, Tuple

import cv2
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

from config import ServerConfig


@dataclass
class TextLine:
    poly: np.ndarray  # shape (4, 2) float32 in full image coords
    x1: float
    y1: float
    x2: float
    y2: float
    text: str
    score: float
    bg_rgb: Tuple[float, float, float]

    @property
    def w(self) -> float:
        return max(1.0, self.x2 - self.x1)

    @property
    def h(self) -> float:
        return max(1.0, self.y2 - self.y1)

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) * 0.5

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) * 0.5


class ComicCVPipeline:
    """
    纯 CPU 轻量漫画视觉处理管线 v3：
    1. RapidOCR (PP-OCRv4 ONNX, use_cls=False 提速) 英文行检测与识别（竖版长条漫自动重叠切片）
    2. 几何邻近 + 气泡黑边屏障检测 + 底色一致性校验 -> 精准聚合成独立气泡块
    3. 基于文字行多边形提取精确字母墨水掩码（保护气泡黑边），局部 Telea/NS 无痕修复并生成
       **Alpha 透明羽化 WebP 贴片**（仅擦除英文笔画，周围 100% 透明，彻底消除“方框感”）
    4. 向气泡内部空白安全扩展排版框 + 按原英文行高输出 origFontRatio 实现原字号自动匹配
    """

    def __init__(self, cfg: ServerConfig):
        self.cfg = cfg
        self._ocr = None
        self._ocr_lock = threading.Lock()

    def _get_ocr(self) -> RapidOCR:
        if self._ocr is None:
            with self._ocr_lock:
                if self._ocr is None:
                    try:
                        self._ocr = RapidOCR(
                            use_cls=False,
                            det_limit_side_len=736,
                            det_thresh=0.25,
                            det_box_thresh=0.40,
                            det_unclip_ratio=1.65,
                            intra_op_num_threads=2,
                        )
                    except TypeError:
                        try:
                            self._ocr = RapidOCR(use_cls=False)
                        except TypeError:
                            self._ocr = RapidOCR()
        return self._ocr

    def warmup(self) -> None:
        """启动预热 ONNX 会话，避免首张漫画冷启动卡顿"""
        ocr = self._get_ocr()
        dummy = np.full((128, 256, 3), 255, dtype=np.uint8)
        try:
            ocr(dummy)
        except Exception:
            pass

    @staticmethod
    def decode_image(image_bytes: bytes) -> np.ndarray:
        pil_img = Image.open(io.BytesIO(image_bytes))
        if pil_img.mode in ("RGBA", "LA") or (
            pil_img.mode == "P" and "transparency" in pil_img.info
        ):
            bg = Image.new("RGB", pil_img.size, (255, 255, 255))
            rgba = pil_img.convert("RGBA")
            bg.paste(rgba, mask=rgba.split()[3])
            rgb = np.array(bg, dtype=np.uint8)
        else:
            rgb = np.array(pil_img.convert("RGB"), dtype=np.uint8)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    @staticmethod
    def _is_valid_english_text(text: str) -> bool:
        t = (text or "").strip()
        if not t:
            return False
        cjk_count = len(re.findall(r"[\u4e00-\u9fff]", t))
        latin_count = len(re.findall(r"[A-Za-z]", t))
        if latin_count == 0 or cjk_count > latin_count:
            return False
        if re.fullmatch(r"(https?://)?(www\.)?[a-z0-9\-]+\.[a-z]{2,}(/\S*)?", t, re.I):
            return False
        return True

    @staticmethod
    def _sample_local_bg_rgb(img_bgr: np.ndarray, x1: float, y1: float, x2: float, y2: float) -> Tuple[float, float, float]:
        h_img, w_img = img_bgr.shape[:2]
        pad = max(3, int((y2 - y1) * 0.25))
        rx1 = max(0, int(x1) - pad)
        ry1 = max(0, int(y1) - pad)
        rx2 = min(w_img, int(x2) + pad)
        ry2 = min(h_img, int(y2) + pad)
        patch = img_bgr[ry1:ry2, rx1:rx2]
        if patch.size == 0:
            return (255.0, 255.0, 255.0)

        border_pixels = np.concatenate(
            [patch[0, :, :], patch[-1, :, :], patch[:, 0, :], patch[:, -1, :]],
            axis=0,
        ).astype(np.float32)

        lum = 0.114 * border_pixels[:, 0] + 0.587 * border_pixels[:, 1] + 0.299 * border_pixels[:, 2]
        order = np.argsort(lum)
        sorted_px = border_pixels[order]
        median_lum = lum[order[len(order) // 2]]

        if median_lum >= 128:
            lo = int(len(sorted_px) * 0.55)
            hi = max(lo + 1, int(len(sorted_px) * 0.90))
        else:
            lo = int(len(sorted_px) * 0.10)
            hi = max(lo + 1, int(len(sorted_px) * 0.45))

        picked = sorted_px[lo:hi]
        b, g, r = np.mean(picked, axis=0)
        return (float(r), float(g), float(b))

    def _run_ocr_on_crop(self, crop_bgr: np.ndarray, offset_y: int) -> List[Tuple[np.ndarray, str, float]]:
        # 0.5ms 快速跳过条漫常见的纯白/纯黑无字过渡画面
        if float(np.std(crop_bgr[::8, ::8])) < 4.5:
            return []

        h, w = crop_bgr.shape[:2]
        max_w = min(self.cfg.max_ocr_width, 1024)
        scale = 1.0
        if w > max_w:
            scale = max_w / float(w)
            resized = cv2.resize(crop_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        elif w < 560 and max(w, h) < 1000:
            scale = min(1.35, 760.0 / float(max(w, 1)))
            resized = cv2.resize(crop_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
        else:
            resized = crop_bgr

        ocr = self._get_ocr()
        result, _ = ocr(resized)
        if not result:
            return []

        items = []
        inv_scale = 1.0 / scale
        for entry in result:
            if not entry or len(entry) < 3:
                continue
            box, text, score = entry[0], str(entry[1]), float(entry[2])
            if score < self.cfg.ocr_min_score:
                continue
            if not self._is_valid_english_text(text):
                continue
            poly = np.array(box, dtype=np.float32) * inv_scale
            poly[:, 1] += float(offset_y)
            items.append((poly, text.strip(), score))
        return items

    def _detect_lines(self, img_bgr: np.ndarray) -> List[TextLine]:
        h, w = img_bgr.shape[:2]
        raw_items: List[Tuple[np.ndarray, str, float]] = []

        if h / max(1.0, float(w)) > 2.3 and h > 1800:
            slice_h = max(1000, int(w * 1.65))
            overlap = int(slice_h * 0.20)
            step = max(400, slice_h - overlap)
            y = 0
            while y < h:
                end_y = min(h, y + slice_h)
                if h - end_y < 220:
                    end_y = h
                raw_items.extend(self._run_ocr_on_crop(img_bgr[y:end_y, :], y))
                if end_y >= h:
                    break
                y += step
        else:
            raw_items = self._run_ocr_on_crop(img_bgr, 0)

        raw_items.sort(key=lambda x: x[2], reverse=True)
        kept: List[TextLine] = []
        for poly, text, score in raw_items:
            x1, y1 = float(np.min(poly[:, 0])), float(np.min(poly[:, 1]))
            x2, y2 = float(np.max(poly[:, 0])), float(np.max(poly[:, 1]))
            x1, y1 = max(0.0, x1), max(0.0, y1)
            x2, y2 = min(float(w), x2), min(float(h), y2)
            if (x2 - x1) < 6 or (y2 - y1) < 6:
                continue

            dup = False
            area_a = (x2 - x1) * (y2 - y1)
            for ex in kept:
                ix1, iy1 = max(x1, ex.x1), max(y1, ex.y1)
                ix2, iy2 = min(x2, ex.x2), min(y2, ex.y2)
                if ix2 > ix1 and iy2 > iy1:
                    inter = (ix2 - ix1) * (iy2 - iy1)
                    area_b = ex.w * ex.h
                    iou = inter / max(1.0, area_a + area_b - inter)
                    contain = inter / max(1.0, min(area_a, area_b))
                    if iou > 0.45 or contain > 0.72:
                        dup = True
                        break
            if not dup:
                bg_rgb = self._sample_local_bg_rgb(img_bgr, x1, y1, x2, y2)
                kept.append(TextLine(poly=poly, x1=x1, y1=y1, x2=x2, y2=y2, text=text, score=score, bg_rgb=bg_rgb))

        return kept

    @staticmethod
    def _has_border_barrier(
        img_gray: np.ndarray, a: TextLine, b: TextLine, bg_lum: float
    ) -> bool:
        upper, lower = (a, b) if a.cy <= b.cy else (b, a)
        y_start = int(upper.y2)
        y_end = int(lower.y1)
        if y_end - y_start < 3:
            return False

        ox1 = max(upper.x1, lower.x1)
        ox2 = min(upper.x2, lower.x2)
        if ox2 - ox1 < 6:
            cx = int((upper.cx + lower.cx) * 0.5)
            ox1, ox2 = cx - 4, cx + 4

        h_img, w_img = img_gray.shape[:2]
        y_start = max(0, min(h_img - 1, y_start))
        y_end = max(y_start + 1, min(h_img, y_end))

        cols = np.linspace(max(0, int(ox1)), min(w_img - 1, int(ox2)), num=5).astype(int)
        barrier_hits = 0
        for cx in cols:
            strip = img_gray[y_start:y_end, cx].astype(np.float32)
            if strip.size == 0:
                continue
            if bg_lum >= 128:
                if float(np.min(strip)) < bg_lum - 68:
                    barrier_hits += 1
            else:
                if float(np.max(strip)) > bg_lum + 68:
                    barrier_hits += 1
        return barrier_hits >= 4

    def _group_lines_into_bubbles(self, img_bgr: np.ndarray, lines: List[TextLine]) -> List[List[TextLine]]:
        n = len(lines)
        if n <= 1:
            return [[lines[0]]] if n == 1 else []

        img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        parent = list(range(n))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        def union(i: int, j: int) -> None:
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[ri] = rj

        for i in range(n):
            a = lines[i]
            for j in range(i + 1, n):
                b = lines[j]
                ref_h = min(a.h, b.h)
                max_h = max(a.h, b.h)
                if max_h > ref_h * 2.35:
                    continue
                bg_dist = math.sqrt(sum((a.bg_rgb[k] - b.bg_rgb[k]) ** 2 for k in range(3)))
                if bg_dist > 55.0:
                    continue

                v_gap = max(b.y1 - a.y2, a.y1 - b.y2)
                h_overlap = min(a.x2, b.x2) - max(a.x1, b.x1)
                h_gap = max(b.x1 - a.x2, a.x1 - b.x2)

                same_bubble = False
                if -ref_h * 0.45 <= v_gap <= ref_h * 1.52:
                    center_dx = abs(a.cx - b.cx)
                    if h_overlap > -ref_h * 0.45 and center_dx <= max(a.w, b.w) * 0.72 + ref_h * 0.85:
                        bg_lum = 0.299 * a.bg_rgb[0] + 0.587 * a.bg_rgb[1] + 0.114 * a.bg_rgb[2]
                        if not self._has_border_barrier(img_gray, a, b, bg_lum):
                            same_bubble = True

                v_overlap = min(a.y2, b.y2) - max(a.y1, b.y1)
                if not same_bubble and v_overlap > ref_h * 0.48 and -ref_h * 0.3 <= h_gap <= ref_h * 1.45:
                    same_bubble = True

                if same_bubble:
                    union(i, j)

        clusters: dict[int, List[TextLine]] = {}
        for idx in range(n):
            clusters.setdefault(find(idx), []).append(lines[idx])

        groups = list(clusters.values())
        for g in groups:
            g.sort(key=lambda ln: (round(ln.cy / max(6.0, ln.h * 0.65)), ln.x1))
        groups.sort(key=lambda g: (min(ln.y1 for ln in g) // 70, min(ln.x1 for ln in g)))
        return groups

    @staticmethod
    def _join_english_lines(lines: List[TextLine]) -> str:
        joined = ""
        for ln in lines:
            piece = ln.text.strip()
            if not piece:
                continue
            if not joined:
                joined = piece
            elif joined.endswith("-") and len(joined) >= 2 and joined[-2].isalpha() and piece[0].isalpha():
                joined = joined[:-1] + piece
            else:
                joined = joined + " " + piece
        return re.sub(r"\s+", " ", joined).strip()

    @staticmethod
    def _expand_safe_interior_box(
        img_bgr: np.ndarray,
        bx1: int,
        by1: int,
        bx2: int,
        by2: int,
        bg_bgr: np.ndarray,
        median_h: float,
    ) -> Tuple[int, int, int, int]:
        """向四个方向探测气泡内部干净空白区，遇到气泡黑边立刻停止，给中文留出自然呼吸空间"""
        h_img, w_img = img_bgr.shape[:2]
        max_pad_x = max(8, min(int(median_h * 1.15), int((bx2 - bx1) * 0.32)))
        max_pad_y = max(6, min(int(median_h * 0.90), int((by2 - by1) * 0.32)))
        tol = 38.0

        def is_clean_strip(strip: np.ndarray) -> bool:
            if strip.size == 0:
                return False
            d = np.linalg.norm(strip.astype(np.float32) - bg_bgr.reshape(1, 3), axis=1)
            return float(np.mean(d < tol)) >= 0.85

        tx1, ty1, tx2, ty2 = bx1, by1, bx2, by2
        mid_y1 = int(by1 + (by2 - by1) * 0.25)
        mid_y2 = max(mid_y1 + 1, int(by2 - (by2 - by1) * 0.25))
        mid_x1 = int(bx1 + (bx2 - bx1) * 0.25)
        mid_x2 = max(mid_x1 + 1, int(bx2 - (bx2 - bx1) * 0.25))

        for step in range(2, max_pad_x + 1, 2):
            if bx1 - step < 0:
                break
            if is_clean_strip(img_bgr[mid_y1:mid_y2, bx1 - step]):
                tx1 = bx1 - step
            else:
                break

        for step in range(2, max_pad_x + 1, 2):
            if bx2 + step >= w_img:
                break
            if is_clean_strip(img_bgr[mid_y1:mid_y2, bx2 + step]):
                tx2 = bx2 + step
            else:
                break

        for step in range(2, max_pad_y + 1, 2):
            if by1 - step < 0:
                break
            if is_clean_strip(img_bgr[by1 - step, mid_x1:mid_x2]):
                ty1 = by1 - step
            else:
                break

        for step in range(2, max_pad_y + 1, 2):
            if by2 + step >= h_img:
                break
            if is_clean_strip(img_bgr[by2 + step, mid_x1:mid_x2]):
                ty2 = by2 + step
            else:
                break

        # 稍微回缩 3px 留安全内边距，避免文字顶住气泡黑线
        margin = 3
        tx1 = min(bx1, tx1 + margin)
        tx2 = max(bx2, tx2 - margin)
        ty1 = min(by1, ty1 + margin)
        ty2 = max(by2, ty2 - margin)
        return tx1, ty1, tx2, ty2

    def _inpaint_bubble_patch(
        self, img_bgr: np.ndarray, lines: List[TextLine]
    ) -> dict:
        """
        生成透明 Alpha 羽化擦字贴片（仅英文字母笔画处不透明无痕修补，周围 100% 透明直透原画）
        同时输出基于原英文行高估算的 origFontRatio 及气泡内部安全排版框
        """
        h_img, w_img = img_bgr.shape[:2]
        median_h = float(np.median([ln.h for ln in lines]))

        bx1 = min(ln.x1 for ln in lines)
        by1 = min(ln.y1 for ln in lines)
        bx2 = max(ln.x2 for ln in lines)
        by2 = max(ln.y2 for ln in lines)

        pad_x = max(6, min(18, int(round(median_h * 0.28))))
        pad_y = max(5, min(16, int(round(median_h * 0.24))))

        cx1 = max(0, int(math.floor(bx1)) - pad_x)
        cy1 = max(0, int(math.floor(by1)) - pad_y)
        cx2 = min(w_img, int(math.ceil(bx2)) + pad_x)
        cy2 = min(h_img, int(math.ceil(by2)) + pad_y)
        cw = max(1, cx2 - cx1)
        ch = max(1, cy2 - cy1)

        crop = img_bgr[cy1:cy2, cx1:cx2].copy()

        # 1. 构建文字行多边形 ROI 掩码
        roi_mask = np.zeros((ch, cw), dtype=np.uint8)
        for ln in lines:
            pts = ln.poly.copy()
            pts[:, 0] -= cx1
            pts[:, 1] -= cy1
            cv2.fillPoly(roi_mask, [np.round(pts).astype(np.int32)], 255)

        roi_k = max(3, min(7, int(round(median_h * 0.14)) | 1))
        roi_dilated = cv2.dilate(
            roi_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (roi_k, roi_k)), iterations=1
        )

        # 2. 精确采样气泡底色
        ring_mask = cv2.dilate(
            roi_dilated, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)), iterations=1
        ) - roi_dilated
        ring_px = crop[ring_mask > 0]
        if len(ring_px) < 20:
            ring_px = crop.reshape(-1, 3)

        ring_f = ring_px.astype(np.float32)
        lum = 0.114 * ring_f[:, 0] + 0.587 * ring_f[:, 1] + 0.299 * ring_f[:, 2]
        order = np.argsort(lum)
        sorted_ring = ring_f[order]
        med_lum = lum[order[len(order) // 2]]
        if med_lum >= 128:
            s_lo, s_hi = int(len(sorted_ring) * 0.50), max(1, int(len(sorted_ring) * 0.88))
        else:
            s_lo, s_hi = int(len(sorted_ring) * 0.12), max(1, int(len(sorted_ring) * 0.50))
        bg_slice = sorted_ring[s_lo:max(s_lo + 1, s_hi)]
        bg_bgr = np.mean(bg_slice, axis=0)
        bg_std = float(np.mean(np.std(bg_slice, axis=0)))
        is_uniform_bg = bg_std < 18.0

        # 3. 提取精确字母墨水掩码（纯色气泡使用更灵敏阈值，彻底抓净浅灰抗锯齿边缘）
        diff = np.linalg.norm(crop.astype(np.float32) - bg_bgr.reshape(1, 1, 3), axis=2)
        if is_uniform_bg:
            ink_thresh = max(12.0, min(32.0, bg_std * 1.8 + 10.0))
        else:
            ink_thresh = max(22.0, min(58.0, bg_std * 2.1 + 16.0))
        ink_mask = ((diff > ink_thresh) & (roi_dilated > 0)).astype(np.uint8) * 255

        # 4. 保护气泡黑边：剔除触及贴片边界且跨度极大的连通域
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(ink_mask, connectivity=8)
        clean_ink = np.zeros_like(ink_mask)
        for lbl in range(1, num_labels):
            lx, ly = stats[lbl, cv2.CC_STAT_LEFT], stats[lbl, cv2.CC_STAT_TOP]
            lw, lh = stats[lbl, cv2.CC_STAT_WIDTH], stats[lbl, cv2.CC_STAT_HEIGHT]
            touches_edge = lx <= 0 or ly <= 0 or (lx + lw) >= cw or (ly + lh) >= ch
            if touches_edge and (lw > cw * 0.72 or lh > ch * 0.72):
                continue
            clean_ink[labels == lbl] = 255

        # 5. 膨胀墨水掩码彻底吃掉字母光晕与斜体细边
        dil_k = max(5, min(11, int(round(median_h * 0.24)) | 1))
        final_mask = cv2.dilate(
            clean_ink, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dil_k, dil_k)), iterations=1
        )
        if int(np.count_nonzero(final_mask)) < 12:
            final_mask = roi_mask

        # 6. 无痕修复：纯色气泡直接用精确底色填净（杜绝 Telea 把灰边带进字心产生残影！）
        if is_uniform_bg:
            inpainted = crop.copy()
            bg_u8 = np.clip(np.round(bg_bgr), 0, 255).astype(np.uint8)
            inpainted[final_mask > 0] = bg_u8
        else:
            method = cv2.INPAINT_NS if self.cfg.inpaint_method == "ns" else cv2.INPAINT_TELEA
            radius = max(4, min(9, int(round(median_h * 0.24))))
            inpainted = cv2.inpaint(crop, final_mask, inpaintRadius=radius, flags=method)

        # 7. 软羽化透明 Alpha 通道（仅笔画区域完全不透明 255，外部 100% 透明直透原漫）
        alpha_core = cv2.dilate(
            final_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1
        )
        alpha_feather = cv2.GaussianBlur(alpha_core, (5, 5), 1.1)
        alpha = np.maximum(final_mask, alpha_feather).astype(np.uint8)

        rgb_patch = cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB)
        rgba_patch = np.dstack([rgb_patch, alpha])
        pil_patch = Image.fromarray(rgba_patch, mode="RGBA")
        buf = io.BytesIO()
        pil_patch.save(buf, format="WEBP", quality=92, method=4)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        # 8. 探测气泡内部安全排版区域 + 原英文真实字号比例
        tx1, ty1, tx2, ty2 = self._expand_safe_interior_box(
            img_bgr,
            int(math.floor(bx1)),
            int(math.floor(by1)),
            int(math.ceil(bx2)),
            int(math.ceil(by2)),
            bg_bgr,
            median_h,
        )

        bg_r, bg_g, bg_b = int(round(bg_bgr[2])), int(round(bg_bgr[1])), int(round(bg_bgr[0]))
        final_lum = 0.299 * bg_r + 0.587 * bg_g + 0.114 * bg_b
        text_color = "rgb(20, 20, 20)" if final_lum > 140 else "rgb(250, 250, 250)"
        bg_color = f"rgb({bg_r}, {bg_g}, {bg_b})"

        is_rect = cw / max(1, ch) > 2.3 and len(lines) <= 2
        orig_font_ratio = round((median_h * 0.88) / max(1.0, float(h_img)), 5)
        # 粗判气泡语气类别，供 LLM 切换口语/旁白/喊叫风格
        if orig_font_ratio >= 0.032:
            bubble_kind = "shout"
        elif is_rect or (cw > w_img * 0.45 and len(lines) >= 3):
            bubble_kind = "narration"
        else:
            bubble_kind = "speech"

        return {
            "x": cx1,
            "y": cy1,
            "width": cw,
            "height": ch,
            "textX": tx1,
            "textY": ty1,
            "textWidth": max(12, tx2 - tx1),
            "textHeight": max(12, ty2 - ty1),
            "imgWidth": w_img,
            "imgHeight": h_img,
            "origFontRatio": orig_font_ratio,
            "isUniformBg": is_uniform_bg,
            "bubbleKind": bubble_kind,
            "inpaintingDataUrl": f"data:image/webp;base64,{b64}",
            "colors": {
                "background": bg_color,
                "text": text_color,
            },
            "shape": "rect" if is_rect else "ellipse",
        }

    def detect_and_inpaint(self, image_bytes: bytes) -> Tuple[List[dict], int, int]:
        img_bgr = self.decode_image(image_bytes)
        h_img, w_img = img_bgr.shape[:2]

        lines = self._detect_lines(img_bgr)
        if not lines:
            return [], w_img, h_img

        groups = self._group_lines_into_bubbles(img_bgr, lines)
        bubbles = []
        for idx, g in enumerate(groups):
            orig = self._join_english_lines(g)
            if not orig:
                continue
            patch_info = self._inpaint_bubble_patch(img_bgr, g)
            patch_info["key"] = f"b-{idx}-{patch_info['x']}-{patch_info['y']}"
            patch_info["original"] = orig
            bubbles.append(patch_info)

        return bubbles, w_img, h_img
