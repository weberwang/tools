from __future__ import annotations

import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from manual_pdf_pages import ManualPdfPage
from validate_manual_pdf import expected_source_pages, validate_pages


def make_page(number: int, lines: int = 30) -> ManualPdfPage:
    """生成指定正文行数和页码的轻量校验样本。"""
    title = "目 录" if number == 1 else f"第 {number} 页的内容"
    body = (title, *(f"正文第 {line} 行" for line in range(2, lines + 1))) if lines else ()
    return ManualPdfPage(printed_number=number, body_lines=body, body_fingerprint=f"源页-{number}-{lines}", issues=())


class ManualPdfRulesTests(unittest.TestCase):
    """覆盖逐页行数、目录和一般交存页段规则。"""

    def test_full_submission_for_60_or_fewer_pages(self) -> None:
        """页数等于 60 时可直接提交完整版，较短手册同样要求完整。"""
        for count in (1, 59, 60):
            full = [make_page(number) for number in range(1, count + 1)]
            self.assertEqual(validate_pages(full, None, {}), (tuple(range(1, count + 1)), []))
        full = [make_page(number) for number in range(1, 4)]
        _, issues = validate_pages(full, full[:2], {})
        self.assertIn("交存 PDF 有 2 页，应为 3 页。", issues)

    def test_long_manual_must_match_first_and_last_30_in_order(self) -> None:
        """中间页不交存，提交件页序应连续且与完整版正文对应。"""
        full = [make_page(number, lines=29 if number == 32 else 30) for number in range(1, 65)]
        expected = (*range(1, 31), *range(35, 65))
        self.assertEqual(expected_source_pages(64), expected)
        actual = [replace(full[source - 1], printed_number=index) for index, source in enumerate(expected, start=1)]
        self.assertEqual(validate_pages(full, actual, {}), (expected, []))
        _, missing = validate_pages(full, None, {})
        self.assertTrue(any("--submission" in message for message in missing))
        actual[30] = replace(full[31], printed_number=35)
        _, wrong = validate_pages(full, actual, {})
        self.assertTrue(any("页眉页码为 35，应为 31" in message for message in wrong))
        self.assertTrue(any("交存版第 31 页与完整版第 35 页" in message for message in wrong))

    def test_exceptions_apply_only_to_short_selected_pages_with_text(self) -> None:
        """按原页记录行数例外，拒绝用例外掩盖无正文的页。"""
        full = [make_page(1, lines=29), make_page(2)]
        _, underfilled = validate_pages(full, None, {})
        self.assertTrue(any("只有 29 行" in message for message in underfilled))
        self.assertEqual(validate_pages(full, None, {1: "目录页，已复核"}), ((1, 2), []))
        _, invalid = validate_pages(full, None, {1: "目录页", 2: "无须例外"})
        self.assertTrue(any("第 2 页的例外无效" in message for message in invalid))
        _, empty = validate_pages([full[0], make_page(2, lines=0)], None, {1: "目录页", 2: "空白页"})
        self.assertTrue(any("只有 0 行" in message for message in empty))

    def test_stale_directory_and_page_layout_fail(self) -> None:
        """旧目录字段和提取器发现的版式问题必须阻止通过。"""
        first = make_page(1)
        body = ("目录", "未找到目录项。", *first.body_lines[2:])
        stale = replace(first, body_lines=body, issues=("不是 A4 纵向。",))
        _, issues = validate_pages([stale], None, {})
        self.assertTrue(any("更新整个目录" in message for message in issues))
        self.assertTrue(any("不是 A4 纵向" in message for message in issues))
