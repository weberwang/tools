from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from common import read_json, write_json  # noqa: E402
from confirm_stage import confirm_code_selection  # noqa: E402
from extract_code_material import MAX_CODE_COLUMNS, display_width, extract, material_code_lines, paginate, wrap_display_line, write_pages_md  # noqa: E402


class CodeLayoutTests(unittest.TestCase):
    def test_display_width_counts_cjk_as_two_columns(self) -> None:
        self.assertEqual(display_width("abc中文"), 7)

    def test_long_line_wrap_preserves_all_characters(self) -> None:
        source = "const value = '" + ("中" * 70) + ("x" * 80) + "';"
        wrapped = wrap_display_line(source, 100)
        self.assertGreater(len(wrapped), 1)
        self.assertEqual("".join(wrapped), source)
        self.assertTrue(all(display_width(line) <= 100 for line in wrapped))

    def test_tabs_are_expanded_before_wrapping(self) -> None:
        wrapped = wrap_display_line("a\tb", 100)
        self.assertEqual(wrapped, ["a   b"])

    def test_material_lines_drop_blanks_and_wrap(self) -> None:
        """折行产生的纯缩进段也不应计入正文。"""
        material = material_code_lines("\nshort\n" + ("x" * 101) + "\n" + (" " * MAX_CODE_COLUMNS) + "pass")
        self.assertEqual(material, ["short", "x" * MAX_CODE_COLUMNS, "x" * (101 - MAX_CODE_COLUMNS), "pass"])

    def test_paginate_uses_physical_lines(self) -> None:
        pages = paginate([str(i) for i in range(101)], 50)
        self.assertEqual([len(page) for page in pages], [50, 50, 1])


class CompleteSourceSelectionTests(unittest.TestCase):
    """验证不足 60 页时源码选择的完整性和排除记录。"""

    def setUp(self) -> None:
        """准备两个真实短源码文件和可确认的选择清单。"""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.draft = self.root / "草稿"
        self.draft.mkdir()
        self.selection = self.draft / "代码文件选择.json"
        (self.project / "main.py").write_text("print('main')\n", encoding="utf-8")
        (self.project / "other.py").write_text("print('other')\n", encoding="utf-8")
        self.data = {
            "selection_required": True,
            "files": [
                {"path": "main.py", "selected": True, "line_count": 1, "model_reason": "主程序"},
                {"path": "other.py", "selected": False, "line_count": 1, "model_reason": ""},
            ],
        }

    def run_extract(self) -> dict:
        """执行与正式工作流相同的确认和源码抽取。"""
        return extract(self.project, self.draft, "示例软件", "V1.0", 55, self.selection)

    def test_missing_candidate_is_not_treated_as_complete(self) -> None:
        """未选择且未说明归属的候选应阻止生成全部源码。"""
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        with self.assertRaisesRegex(SystemExit, "other.py"):
            self.run_extract()
        self.assertFalse((self.draft / "代码-全部.md").exists())

    def test_all_source_files_are_included(self) -> None:
        """全部相关文件入选时可生成完整材料。"""
        self.data["files"][1]["selected"] = True
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        result = self.run_extract()
        self.assertEqual(result["mode"], "all_under_60_pages")
        self.assertEqual([item["path"] for item in result["files"]], ["main.py", "other.py"])
        self.assertEqual(result["material_line_count"], 2)
        material = (self.draft / "代码-全部.md").read_text(encoding="utf-8")
        self.assertIn("print('other')", material)
        self.assertNotIn("other.py", material)

    def test_confirmed_exclusion_is_recorded(self) -> None:
        """无关候选经明确说明与确认后写入抽取清单。"""
        self.data["files"][1]["model_reason"] = "不属于申请软件：独立维护工具"
        # 即使全部候选估算超过 60 页，也不能强制把无关文件作为申请软件源码。
        self.data["files"][1]["line_count"] = 4000
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        result = self.run_extract()
        self.assertEqual(result["excluded_files"], [{"path": "other.py", "reason": "不属于申请软件：独立维护工具"}])
        self.assertIn("独立维护工具", (self.draft / "代码提取清单.md").read_text(encoding="utf-8"))
        self.assertEqual(read_json(self.draft / "代码提取清单.json")["excluded_files"], result["excluded_files"])

    def test_exclusion_changed_after_confirmation_requires_reconfirmation(self) -> None:
        """确认后调整排除理由会使门禁失效。"""
        self.data["files"][1]["model_reason"] = "不属于申请软件：第三方样例"
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        updated = read_json(self.selection)
        updated["files"][1]["model_reason"] = "不属于申请软件：独立工具"
        self.selection.write_text(json.dumps(updated, ensure_ascii=False), encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "重新执行"):
            self.run_extract()

    def test_selection_reason_is_not_an_exclusion_reason(self) -> None:
        """取消选择后原有入选理由不能替代经确认的排除依据。"""
        self.data["files"][1]["model_reason"] = "核心业务逻辑"
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        with self.assertRaisesRegex(SystemExit, "other.py"):
            self.run_extract()

    def test_source_missing_from_inventory_blocks_complete_output(self) -> None:
        """清单截断或确认后新增的候选文件不能静默遗漏。"""
        self.data["files"][1]["selected"] = True
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        (self.project / "new.py").write_text("print('new')\n", encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "new.py"):
            self.run_extract()

    def test_deleted_selected_source_blocks_complete_output(self) -> None:
        """被选源码文件消失时不能将剩余代码称为全部。"""
        self.data["files"][1]["selected"] = True
        write_json(self.selection, self.data)
        confirm_code_selection(self.root, "确认")
        (self.project / "other.py").unlink()
        with self.assertRaisesRegex(SystemExit, "other.py"):
            self.run_extract()

    def test_markdown_fences_exceed_backticks_in_each_page(self) -> None:
        """源码中的多重反引号应完整写入各自的代码块。"""
        target = self.draft / "源码.md"
        write_pages_md(target, "源码", "示例软件", "V1.0", [
            (1, ["const content = `", "```js", "source code", "```", "`;"]),
            (2, ["````", "result"]),
            (3, ["print('example')"]),
        ])
        content = target.read_text(encoding="utf-8")
        self.assertIn("````text\nconst content = `\n```js\nsource code\n```\n`;\n````\n", content)
        self.assertIn("`````text\n````\nresult\n`````\n", content)
        self.assertIn("```text\nprint('example')\n```\n", content)


if __name__ == "__main__":
    unittest.main()
