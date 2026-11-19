#!/usr/bin/env python3
"""核验 Word 或 WPS 导出的操作手册 PDF 及一般交存页段。"""

from __future__ import annotations

import argparse
from pathlib import Path

from manual_pdf_pages import ManualPdfPage, read_manual_pdf

# 一般交存采用前、后连续 30 页，文档普通页至少 30 行。
SEGMENT_PAGES = 30
MIN_BODY_LINES = 30


def expected_source_pages(total: int) -> tuple[int, ...]:
    """按完整版的物理页码计算应交存的页段，正好 60 页时交存全文。"""
    if total <= SEGMENT_PAGES * 2:
        return tuple(range(1, total + 1))
    return (*range(1, SEGMENT_PAGES + 1), *range(total - SEGMENT_PAGES + 1, total + 1))


def check_page_layout(page: ManualPdfPage, number: int, label: str) -> list[str]:
    """用指定页序检查 PDF 页眉页码和页面读取结果。"""
    location = f"{label}第 {number} 页"
    issues = [f"{location}：{reason}" for reason in page.issues]
    if page.printed_number != number:
        found = "无法读取" if page.printed_number is None else str(page.printed_number)
        issues.append(f"{location}：页眉页码为 {found}，应为 {number}。")
    return issues


def validate_pages(
    full: list[ManualPdfPage],
    submission: list[ManualPdfPage] | None,
    exceptions: dict[int, str],
) -> tuple[tuple[int, ...], list[str]]:
    """检查交存页正文、例外记录、页段顺序和交存文件的连续页码。"""
    if not full:
        return (), ["完整版 PDF 没有页面。"]

    expected = expected_source_pages(len(full))
    issues: list[str] = []
    first = full[0].body_lines
    first_title = "".join(first[0].split()) if first else ""
    toc_placeholders = ("未找到目录项", "未找到目錄項", "update field to see table of contents")
    if (first_title not in {"目录", "目錄"} or len(first) < 2
            or any(marker in line.casefold() for marker in toc_placeholders for line in first[1:])):
        issues.append("完整版第 1 页应从已更新的目录开始。请更新整个目录后从 Word/WPS 重新导出。")

    for number, reason in exceptions.items():
        if number not in expected or not reason.strip() or not 0 < len(full[number - 1].body_lines) < MIN_BODY_LINES:
            issues.append(f"完整版第 {number} 页的例外无效。例外仅用于有正文且少于 {MIN_BODY_LINES} 行的交存页。")

    for number in expected:
        page = full[number - 1]
        issues.extend(check_page_layout(page, number, "完整版"))
        lines = len(page.body_lines)
        # 例外不能替代可提取正文，空白页和纯扫描页始终需要重新导出。
        if lines == 0 or (lines < MIN_BODY_LINES and not exceptions.get(number, "").strip()):
            issues.append(f"完整版第 {number} 页只有 {lines} 行可提取正文，普通页应至少 {MIN_BODY_LINES} 行。")

    if submission is None:
        if len(full) > SEGMENT_PAGES * 2:
            issues.append("完整版超过 60 页。请提供实际交存 PDF（--submission）以核对页段和连续页码。")
        return expected, issues

    if len(submission) != len(expected):
        issues.append(f"交存 PDF 有 {len(submission)} 页，应为 {len(expected)} 页。")
    for number, (source_number, page) in enumerate(zip(expected, submission), start=1):
        issues.extend(check_page_layout(page, number, "交存版"))
        # 两份 PDF 的页眉页码可能不同。核对有序正文指纹，确保页数相同但错取中间页也会失败。
        source = full[source_number - 1]
        if page.body_fingerprint != source.body_fingerprint or len(page.body_lines) != len(source.body_lines):
            issues.append(f"交存版第 {number} 页与完整版第 {source_number} 页的正文不一致。")
    return expected, issues


def parse_exception(value: str) -> tuple[int, str]:
    """解析以完整版物理页码记录的例外理由。"""
    page, _, reason = value.partition("=")
    if not page.isascii() or not page.isdigit() or int(page) < 1 or not reason.strip():
        raise argparse.ArgumentTypeError("例外格式应为“完整版页码=具体理由”，页码为正整数")
    return int(page), reason.strip()


def main() -> int:
    """读取完整版与交存版 PDF，输出逐页报告和验证结果。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manual", type=Path, required=True, help="更新目录后导出的完整版操作手册 PDF")
    parser.add_argument("--submission", type=Path, help="实际交存 PDF。完整版超过 60 页时必填")
    parser.add_argument("--exception", type=parse_exception, action="append", default=[],
                        help="已人工核对的行数例外，格式为“完整版页码=具体理由”，可重复使用")
    args = parser.parse_args()
    exceptions = dict(args.exception)
    if len(exceptions) != len(args.exception):
        parser.error("同一完整版页码只能记录一次例外。")

    try:
        full = read_manual_pdf(args.manual)
        submission = read_manual_pdf(args.submission) if args.submission is not None else None
    except ValueError as error:
        print(f"PDF 校验失败。{error}")
        return 1

    expected, issues = validate_pages(full, submission, exceptions)
    if len(full) > SEGMENT_PAGES * 2:
        print(f"交存页段为完整版第 1–{SEGMENT_PAGES} 页及第 {expected[SEGMENT_PAGES]}–{len(full)} 页。")
    elif expected:
        print(f"交存页段为完整版全文，共 {len(full)} 页。")

    selected = {source: position for position, source in enumerate(expected, start=1)}
    for number, page in enumerate(full, start=1):
        note = "交存" if number in selected else "未交存"
        if number in selected and number in exceptions and 0 < len(page.body_lines) < MIN_BODY_LINES:
            note = f"例外待人工复核：{exceptions[number]}"
        position = selected.get(number)
        if submission is not None and position is not None and position <= len(submission):
            note += f"，对应交存版第 {position} 页（{len(submission[position - 1].body_lines)} 行）"
        print(f"完整版第 {number} 页，{len(page.body_lines)} 行正文，{note}。")

    if issues:
        print("PDF 校验失败。")
        for issue in issues:
            print(f"- {issue}")
        return 1

    result = "有已记录的行数例外待人工复核。" if exceptions else ""
    print(f"PDF 自动校验通过。{result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
