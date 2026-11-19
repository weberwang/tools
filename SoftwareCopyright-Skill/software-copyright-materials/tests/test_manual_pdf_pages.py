"""验证操作手册 PDF 的正文、页码和图片提取。"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from manual_pdf_pages import ManualPdfPage, read_manual_pdf  # noqa: E402

HAS_PDFPLUMBER = importlib.util.find_spec("pdfplumber") is not None


def create_pdf(path: Path, *, number: int, body: str, pixel: bytes = b"\xff\x00\x00",
               cropbox: bytes = b"", body_y: int = 760, body_commands: str | None = None) -> None:
    """用标准库生成一个包含页眉、正文、页脚和一张图片的 PDF。"""
    commands = (
        f"BT /F1 10 Tf 500 815 Td ({number}) Tj ET\n"
        + (body_commands if body_commands is not None else f"BT /F1 12 Tf 70 {body_y} Td ({body}) Tj ET\n")
        + "BT /F1 9 Tf 70 20 Td (Footer) Tj ET\n"
        "q 40 0 0 40 80 600 cm /Im1 Do Q\n"
    ).encode("ascii")
    compressed = zlib.compress(pixel)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.2756 841.8898] " + cropbox +
        b"/Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(commands)).encode() + b" >>\nstream\n" + commands + b"endstream",
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB "
        b"/BitsPerComponent 8 /Filter /FlateDecode /Length " + str(len(compressed)).encode()
        + b" >>\nstream\n" + compressed + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode())
    path.write_bytes(output)


class ManualPdfPageTests(unittest.TestCase):
    """覆盖 PDF 的关键提取与可比对边界。"""

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_page_number_excluded_from_body_fingerprint(self) -> None:
        """修改页码后，正文行数和内容指纹仍保持一致。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "first.pdf", root / "second.pdf"
            create_pdf(first, number=1, body="First body")
            create_pdf(second, number=31, body="First body")
            first_page = read_manual_pdf(first)[0]
            second_page = read_manual_pdf(second)[0]
            self.assertEqual(first_page.printed_number, 1)
            self.assertEqual(second_page.printed_number, 31)
            self.assertEqual(first_page.body_lines, ("First body",))
            self.assertEqual(first_page.body_fingerprint, second_page.body_fingerprint)
            self.assertFalse(first_page.issues)
            self.assertIsInstance(first_page, ManualPdfPage)

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_body_text_and_image_changes_change_fingerprint(self) -> None:
        """正文文字或图片内容变更都应改变页面指纹。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, text, image = (root / name for name in ("first.pdf", "text.pdf", "image.pdf"))
            create_pdf(first, number=1, body="Original")
            create_pdf(text, number=1, body="Different")
            create_pdf(image, number=1, body="Original", pixel=b"\x00\xff\x00")
            first_page = read_manual_pdf(first)[0]
            self.assertNotEqual(first_page.body_fingerprint, read_manual_pdf(text)[0].body_fingerprint)
            self.assertNotEqual(first_page.body_fingerprint, read_manual_pdf(image)[0].body_fingerprint)

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_empty_text_requires_review(self) -> None:
        """图片页没有可提取正文时须明确交由人工核对。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "image.pdf"
            create_pdf(path, number=1, body="")
            page = read_manual_pdf(path)[0]
            self.assertEqual(page.body_lines, ())
            self.assertTrue(any("没有可提取文本" in issue for issue in page.issues))

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_cropbox_limits_extraction_to_visible_area(self) -> None:
        """偏移可见区域外的原页眉不能被当作有效页码。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cropped.pdf"
            create_pdf(path, number=1, body="Visible body", cropbox=b"/CropBox [30 100 565 800] ", body_y=720)
            page = read_manual_pdf(path)[0]
            self.assertIsNone(page.printed_number)
            self.assertEqual(page.body_lines, ("Visible body",))
            self.assertTrue(any("不是 A4" in issue for issue in page.issues))
            self.assertTrue(any("未识别" in issue for issue in page.issues))

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_invalid_pdf_reports_error(self) -> None:
        """文件损坏时返回带路径的中文错误。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.pdf"
            path.write_bytes(b"not pdf")
            with self.assertRaisesRegex(ValueError, "无法读取操作手册 PDF"):
                read_manual_pdf(path)

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_mixed_font_sizes_and_superscript_count_as_one_row(self) -> None:
        """同基线字号差异和独立基线上标不应增加正文行数。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mixed.pdf"
            commands = []
            for index in range(30):
                baseline = 760 - index * 20
                commands.append(
                    f"BT /F1 16 Tf 70 {baseline} Td (A) Tj /F1 9 Tf (b) Tj ET\n"
                )
                if index == 0:
                    commands.append(f"BT /F1 6 Tf 86 {baseline + 5} Td (2) Tj ET\n")
            create_pdf(path, number=1, body="", body_commands="".join(commands))
            page = read_manual_pdf(path)[0]
            self.assertEqual(len(page.body_lines), 30)
            self.assertIn("2", page.body_lines[0])
            self.assertFalse(page.issues)

    @unittest.skipUnless(HAS_PDFPLUMBER, "逐页 PDF 提取需要安装 pdfplumber")
    def test_adjacent_large_font_lines_remain_separate(self) -> None:
        """相邻大字号行的基线接近时仍分别计数。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "adjacent.pdf"
            commands = (
                "BT /F1 16 Tf 70 760 Td (First) Tj ET\n"
                "BT /F1 16 Tf 70 750 Td (Second) Tj ET\n"
            )
            create_pdf(path, number=1, body="", body_commands=commands)
            page = read_manual_pdf(path)[0]
            self.assertEqual(page.body_lines, ("First", "Second"))

    def test_missing_parser_gives_installation_instruction(self) -> None:
        """缺少解析依赖时给出安装命令。"""
        with patch.dict(sys.modules, {"pdfplumber": None}):
            with self.assertRaisesRegex(ValueError, "pip install"):
                read_manual_pdf(Path("manual.pdf"))


if __name__ == "__main__":
    unittest.main()
