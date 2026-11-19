"""读取操作手册 PDF 的可提取正文、页码和页面内容指纹。"""

from __future__ import annotations

import hashlib
import json
import re
import statistics
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# 文档生成使用 A4 纵向页面、2.5 cm 正文边距和 0.9 cm 页眉页脚位置。
HEADER_FOOTER_BAND = 1.8 * 72 / 2.54
A4_WIDTH_PT = 210 * 72 / 25.4
A4_HEIGHT_PT = 297 * 72 / 25.4
A4_TOLERANCE_PT = 3.0


@dataclass(frozen=True)
class ManualPdfPage:
    """记录 PDF 单页提取结果，供交存范围与正文一致性检查使用。"""

    printed_number: int | None
    body_lines: tuple[str, ...]
    body_fingerprint: str
    issues: tuple[str, ...]


def _printed_number(page: Any) -> int | None:
    """从右上页眉读取唯一的阿拉伯数字页码。"""
    x0, top, x1, _ = page.bbox
    header = page.crop((x0 + page.width * 0.60, top, x1, top + HEADER_FOOTER_BAND))
    text = header.dedupe_chars().extract_text() or ""
    normalized = unicodedata.normalize("NFKC", text)
    numbers = re.findall(r"第\s*(\d+)\s*页", normalized)
    if not numbers:
        # 兼容右上角单独显示页码的 PDF，但不把版本号中的数字误认为页码。
        numbers = re.findall(r"(?m)^\s*(\d+)\s*$", normalized)
    return int(numbers[0]) if len(numbers) == 1 else None


def _body_image_fingerprints(page: Any, issues: list[str]) -> list[dict[str, Any]]:
    """为正文内各图片记录解码内容和位置，保持页码改动不影响比对。"""
    images: list[dict[str, Any]] = []
    page_x0, page_top, _, page_bottom = page.bbox
    upper = page_top + HEADER_FOOTER_BAND
    lower = page_bottom - HEADER_FOOTER_BAND
    for image in page.images:
        if image["bottom"] <= upper or image["top"] >= lower:
            continue
        try:
            stream = image["stream"]
            data = stream.get_data()
            digest = hashlib.sha256(data).hexdigest()
            # 遮罩可能携带透明度，其内容发生变化也应影响指纹。
            mask = stream.attrs.get("SMask")
            if mask is not None:
                mask = mask.resolve() if hasattr(mask, "resolve") else mask
                digest += ":" + hashlib.sha256(mask.get_data()).hexdigest()
            images.append({
                "box": [
                    round(float(image["x0"]) - page_x0, 1),
                    round(float(image["top"]) - page_top, 1),
                    round(float(image["x1"]) - page_x0, 1),
                    round(float(image["bottom"]) - page_top, 1),
                ],
                "size": list(image.get("srcsize") or ()),
                "bits": image.get("bits"),
                "sha256": digest,
            })
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            issues.append(f"正文图片无法可靠读取，需人工核对：{exc}")
    return sorted(images, key=lambda value: (value["box"], value["sha256"]))


def _extract_body_lines(body: Any, issues: list[str]) -> tuple[str, ...]:
    """按文字基线合并正文行，并将相邻的上标或下标合入主行。"""
    from pdfplumber.utils import extract_text

    deduplicated = body.dedupe_chars()
    characters = deduplicated.chars
    if not characters:
        return ()
    if any(not char.get("upright") or len(char.get("matrix") or ()) != 6 for char in characters):
        issues.append("正文包含旋转文字或缺少文字基线，需人工核对行数")
        text = deduplicated.extract_text() or ""
        return tuple(line.strip() for line in text.splitlines() if line.strip())

    # 同一基线的不同字号字形顶部不同，按顶部聚类会把一行误算为多行。
    groups: list[list[dict[str, Any]]] = []
    for char in sorted(characters, key=lambda item: -item["matrix"][5]):
        baseline = char["matrix"][5]
        if groups and abs(groups[-1][0]["matrix"][5] - baseline) <= 1.0:
            groups[-1].append(char)
        else:
            groups.append([char])

    def bounds(group: list[dict[str, Any]]) -> tuple[float, float, float, float, float]:
        """取得一组文字的横向范围、字形范围和字号中位数。"""
        return (
            min(char["x0"] for char in group),
            max(char["x1"] for char in group),
            min(char["top"] for char in group),
            max(char["bottom"] for char in group),
            statistics.median(char["size"] for char in group),
        )

    # 较小的上标、下标可能使用独立基线。只合并字形相交且横向相邻的主行。
    for group in list(groups):
        if group not in groups:
            continue
        left, right, top, bottom, size = bounds(group)
        candidates = []
        for other in groups:
            baseline_gap = abs(group[0]["matrix"][5] - other[0]["matrix"][5])
            if other is group or baseline_gap > 6.0:
                continue
            other_left, other_right, other_top, other_bottom, other_size = bounds(other)
            horizontal_gap = max(0.0, other_left - right, left - other_right)
            if (size < other_size * 0.8
                    and baseline_gap <= other_size * 0.55
                    and min(bottom, other_bottom) > max(top, other_top)
                    and horizontal_gap <= other_size):
                candidates.append((baseline_gap, horizontal_gap, other))
        if candidates:
            target = min(candidates, key=lambda item: item[:2])[2]
            target.extend(group)
            groups.remove(group)

    lines = []
    for group in sorted(groups, key=lambda item: -statistics.median(char["matrix"][5] for char in item)):
        # 一个分组只包含一条基线，较大的 y 容差仅用于在组内按横坐标拼接。
        line = extract_text(group, y_tolerance=1000).strip()
        if line:
            lines.append(line)
    return tuple(lines)


def _read_page(page: Any) -> ManualPdfPage:
    """按实际 PDF 坐标提取单页，并记录无法自动确认的情况。"""
    issues: list[str] = []
    if (abs(page.width - A4_WIDTH_PT) > A4_TOLERANCE_PT
            or abs(page.height - A4_HEIGHT_PT) > A4_TOLERANCE_PT):
        issues.append("页面可见尺寸不是 A4 纵向，需核对页面设置")
    if page.width <= 0 or page.height <= HEADER_FOOTER_BAND * 2:
        raise ValueError("PDF 页面尺寸过小，无法分离页眉、正文和页脚")

    number = _printed_number(page)
    if number is None:
        issues.append("右上页眉未识别出唯一页码")
    # 裁剪上下区域排除页眉、页脚。PDF 图片不是可计算的正文文本行。
    x0, top, x1, bottom = page.bbox
    body = page.crop((x0, top + HEADER_FOOTER_BAND, x1, bottom - HEADER_FOOTER_BAND))
    lines = _extract_body_lines(body, issues)
    if not lines:
        issues.append("正文没有可提取文本，无法自动核验行数")
    images = _body_image_fingerprints(page, issues)
    # 保留全角标点等实际字符，避免把内容有区别的两页视为同一页。
    normalized_lines = [re.sub(r"\s+", " ", unicodedata.normalize("NFC", line)).strip() for line in lines]
    material = json.dumps({"lines": normalized_lines, "images": images}, ensure_ascii=False, sort_keys=True)
    return ManualPdfPage(
        printed_number=number,
        body_lines=lines,
        body_fingerprint=hashlib.sha256(material.encode("utf-8")).hexdigest(),
        issues=tuple(issues),
    )


def read_manual_pdf(path: Path) -> list[ManualPdfPage]:
    """读取文本型手册 PDF，并逐页返回行数依据、页码和可比对的指纹。"""
    try:
        import pdfplumber
    except ImportError as exc:
        raise ValueError('缺少 PDF 解析依赖，请执行 python -m pip install "pdfplumber>=0.11,<0.12"') from exc

    try:
        with pdfplumber.open(path) as document:
            if not document.pages:
                raise ValueError("PDF 没有页面")
            pages = []
            for page in document.pages:
                # PDF 默认按 MediaBox 提取，实际可见内容以 CropBox 与 MediaBox 的交集为准。
                media = page.mediabox
                crop = page.cropbox
                visible = (max(media[0], crop[0]), max(media[1], crop[1]),
                           min(media[2], crop[2]), min(media[3], crop[3]))
                if visible[0] >= visible[2] or visible[1] >= visible[3]:
                    raise ValueError(f"第 {page.page_number} 页的可见区域无效")
                pages.append(_read_page(page.crop(visible)))
            return pages
    except Exception as exc:
        raise ValueError(f"无法读取操作手册 PDF {path}：{exc}") from exc
