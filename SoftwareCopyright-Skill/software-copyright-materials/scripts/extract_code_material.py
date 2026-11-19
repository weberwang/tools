#!/usr/bin/env python3
"""Extract real source code and create Markdown draft pages."""

from __future__ import annotations

import argparse
import re
import unicodedata
from pathlib import Path
from typing import Any

from common import (
    CODE_LINES_PER_PAGE,
    CODE_MIN_LINES_PER_PAGE,
    CODE_MAX_COLUMNS,
    FRONTEND_EXTS,
    confirmation_is_current,
    ensure_dir,
    is_source_candidate,
    iter_source_files,
    read_json,
    read_text,
    rel,
    safe_filename,
    write_json,
)


# Used only to estimate how much source is needed for the first/last 30-page sets.
# Final DOCX pagination is performed by Word's layout engine without hard page breaks.
LINES_PER_PAGE = CODE_LINES_PER_PAGE
SPLIT_THRESHOLD_PAGES = 60
MAX_CODE_COLUMNS = CODE_MAX_COLUMNS


def category_weight(path: Path, project: Path) -> tuple[int, str]:
    r = rel(path, project).lower()
    name = path.name.lower()
    priority = 80
    if name in {"main.ts", "main.js", "main.tsx", "main.jsx", "app.vue", "app.tsx"} or r in {
        "src/app/page.tsx",
        "src/app/layout.tsx",
        "app/page.tsx",
        "app/layout.tsx",
    } or r.endswith("/src/app/page.tsx") or r.endswith("/src/app/layout.tsx"):
        priority = 0
    elif path.suffix.lower() in {".css", ".scss", ".sass", ".less"}:
        priority = 90
    elif "/router/" in r or "/routes/" in r or "router." in r or "routes." in r:
        priority = 10
    elif "/pages/" in r or "/views/" in r or "/app/" in r or "/screens/" in r:
        priority = 20
    elif "/api/" in r or "/apis/" in r or "/services/" in r or "request." in r:
        priority = 30
    elif "/store/" in r or "/stores/" in r or "/pinia/" in r or "/redux/" in r:
        priority = 40
    elif "/components/" in r:
        priority = 50
    elif "/utils/" in r or "/lib/" in r or "/hooks/" in r or "/composables/" in r:
        priority = 60
    elif path.suffix.lower() not in FRONTEND_EXTS:
        if any(part in r for part in ("/backend/app/", "/server/", "/api/", "/services/", "/models/", "/schemas/", "/workers/")):
            priority = 70
        elif name in {"docker-compose.yml", "docker-compose.yaml", "pyproject.toml"} or path.suffix.lower() in {".toml", ".yml", ".yaml"}:
            priority = 95
        else:
            priority = 100
    return priority, r


def should_skip_file(path: Path) -> bool:
    return not is_source_candidate(path)


def selected_line_estimate(item: dict[str, Any]) -> int:
    """按源码折行后的非空排版行估算，文件路径只在清单中记录。"""
    try:
        total = int(item.get("material_line_count", item.get("line_count", 0)))
    except (TypeError, ValueError):
        total = 0
    return max(0, total)


def available_pages_from_selection(selection_path: Path | None, lines_per_page: int) -> tuple[int, int, int]:
    if selection_path is None or not selection_path.exists():
        return 0, 0, 0
    data = read_json(selection_path)
    items = data.get("files") if isinstance(data, dict) else []
    if not isinstance(items, list):
        return 0, 0, 0
    available_lines = sum(selected_line_estimate(item) for item in items if isinstance(item, dict))
    unselected = sum(1 for item in items if isinstance(item, dict) and not item.get("selected") and selected_line_estimate(item) > 0)
    pages = (available_lines + lines_per_page - 1) // lines_per_page if available_lines else 0
    return available_lines, pages, unselected


def display_width(text: str) -> int:
    """Return deterministic monospace display columns for Latin and CJK text."""
    width = 0
    for char in text:
        width += 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
    return width


def wrap_display_line(line: str, max_columns: int = MAX_CODE_COLUMNS) -> list[str]:
    """Wrap one source line without dropping characters or relying on Word wrapping."""
    if max_columns < 8:
        raise ValueError("max_columns must be at least 8")
    expanded = line.expandtabs(4)
    if not expanded:
        return [""]
    segments: list[str] = []
    current: list[str] = []
    current_width = 0
    for char in expanded:
        char_width = 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
        if current and current_width + char_width > max_columns:
            segments.append("".join(current))
            current = []
            current_width = 0
        current.append(char)
        current_width += char_width
    if current:
        segments.append("".join(current))
    return segments


def source_code_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip()]


def material_code_lines(text: str, max_columns: int = MAX_CODE_COLUMNS) -> list[str]:
    """生成用于鉴别材料的非空源码行。"""
    lines: list[str] = []
    for source_line in source_code_lines(text):
        # 超长缩进可能折出纯空白段，这些段不占用正式材料的排版行。
        lines.extend(segment for segment in wrap_display_line(source_line, max_columns) if segment.strip())
    return lines


def load_selected_files(project: Path, selection_path: Path | None) -> list[dict[str, Any]]:
    if selection_path is None:
        raise SystemExit(
            "STOP_FOR_USER\n"
            "NEXT_ACTION: 代码抽取必须先使用 propose_code_selection.py 生成并确认 草稿/代码文件选择.json。"
        )

    data = read_json(selection_path)
    if isinstance(data, dict) and data.get("selection_required") and not data.get("user_confirmed"):
        raise SystemExit(
            "STOP_FOR_USER\n"
            "NEXT_ACTION: 代码文件选择尚未确认。请先确认或修改 草稿/代码文件选择.json，"
            "再运行 `python3 <SKILL_DIR>/scripts/confirm_stage.py --workdir 软件著作权申请资料 --stage code-selection --note \"<用户确认内容>\"`。"
        )
    items = data.get("files") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise SystemExit(f"Invalid selection file: {selection_path}")

    selected = []
    for item in items:
        if not isinstance(item, dict) or not item.get("selected"):
            continue
        path_value = item.get("path")
        if not path_value:
            continue
        selected.append(
            {
                "path": str(path_value),
                "selected": True,
            }
        )
    return selected


def collect_code_lines(project: Path, selection_path: Path | None) -> tuple[list[str], list[dict[str, Any]]]:
    """读取已选源码并记录每个文件在材料中的位置。"""
    selected_items = load_selected_files(project, selection_path)
    all_lines: list[str] = []
    manifest_files: list[dict[str, Any]] = []

    for item in selected_items:
        path = (project / item["path"]).resolve()
        try:
            path.relative_to(project.resolve())
        except ValueError:
            raise SystemExit(f"Selected file is outside project: {path}")
        if should_skip_file(path):
            raise SystemExit(f"已选源码文件不存在、不可读取或不再符合候选条件：{path}")
        text = read_text(path)
        source_lines = text.splitlines()
        selected_source_lines = source_code_lines(text)
        selected_lines = material_code_lines(text)
        if not selected_source_lines:
            continue
        start = len(all_lines) + 1
        # 文件和行范围记录在提取清单内，不往鉴别材料的正文插入人工标记。
        all_lines.extend(selected_lines)
        end = len(all_lines)
        source_end_line = len(source_lines)
        manifest_files.append(
            {
                "path": rel(path, project),
                "source_line_count": len(source_lines),
                "blank_line_count": len(source_lines) - len(selected_source_lines),
                "selected_line_start": 1,
                "selected_line_end": source_end_line,
                "selected_line_count": len(selected_source_lines),
                "material_line_count": len(selected_lines),
                "material_line_start": start,
                "material_line_end": end,
            }
        )
    return all_lines, manifest_files


def paginate(lines: list[str], lines_per_page: int) -> list[list[str]]:
    return [lines[i : i + lines_per_page] for i in range(0, len(lines), lines_per_page)]


def write_pages_md(path: Path, title: str, software_name: str, version: str, pages: list[tuple[int, list[str]]]) -> None:
    """将各页源码写入 Markdown，并避免源码中的反引号提前结束代码块。"""
    chunks = [f"# {title}", "", f"软件名称：{software_name}", f"版本号：{version}", ""]
    for page_no, page_lines in pages:
        # 围栏必须长于该页正文中最长的连续反引号，才能保留原始源码。
        longest_backticks = max(
            (len(match.group()) for line in page_lines for match in re.finditer(r"`+", line)),
            default=0,
        )
        fence = "`" * max(3, longest_backticks + 1)
        chunks.extend([f"## 第 {page_no} 页", "", f"{fence}text"])
        chunks.extend(page_lines)
        chunks.extend([fence, ""])
    path.write_text("\n".join(chunks), encoding="utf-8")


def write_manifest_md(path: Path, manifest: dict[str, Any]) -> None:
    """生成人工可核对的源码来源及排除理由清单。"""
    lines = [
        "# 代码提取清单",
        "",
        f"- 软件名称：{manifest['software_name']}",
        f"- 版本号：{manifest['version']}",
        f"- 项目目录：{manifest['project_root']}",
        f"- 源码文件数：{manifest['file_count']}",
        f"- 材料代码行数：{manifest['material_line_count']}",
        f"- 每页行数：{manifest['lines_per_page']}",
        f"- 单行最大显示宽度：{manifest['max_code_columns']} 列",
        f"- 已选源码估算总页数：{manifest['total_pages']}",
        f"- 实际提交材料页数：{manifest['submitted_page_count']}",
        f"- 目标页数：{manifest['target_pages']}",
        f"- 候选源码可生成页数：{manifest['available_candidate_pages']}",
        f"- 补充状态：{manifest['supplement_status']}",
        f"- 输出模式：{manifest['mode']}",
        "",
        "## 文件来源",
        "",
        "| 文件 | 源码行数 | 抽取源码范围 | 抽取源码行数 | 材料物理行数 | 材料行范围 |",
        "| --- | ---: | --- | ---: | ---: | --- |",
    ]
    for item in manifest["files"]:
        lines.append(
            f"| `{item['path']}` | {item['source_line_count']} | "
            f"{item['selected_line_start']}-{item['selected_line_end']} | "
            f"{item['selected_line_count']} | "
            f"{item['material_line_count']} | "
            f"{item['material_line_start']}-{item['material_line_end']} |"
        )
    if manifest.get("excluded_files"):
        lines.extend(["", "## 经确认不属于申请软件的候选文件", ""])
        for item in manifest["excluded_files"]:
            lines.append(f"- `{item['path']}`：{item['reason']}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def extract(project: Path, out_dir: Path, software_name: str, version: str, lines_per_page: int, selection_path: Path | None) -> dict[str, Any]:
    """根据确认的文件选择生成源码材料及可追溯清单。"""
    if not CODE_MIN_LINES_PER_PAGE <= lines_per_page <= LINES_PER_PAGE:
        raise ValueError(f"每页源码行数应在 {CODE_MIN_LINES_PER_PAGE}–{LINES_PER_PAGE} 之间")
    ensure_dir(out_dir)
    code_lines, files = collect_code_lines(project, selection_path)
    if not code_lines:
        raise SystemExit("No selected frontend source code files found for extraction.")

    pages = paginate(code_lines, lines_per_page)
    total_pages = len(pages)
    available_lines, available_pages, _ = available_pages_from_selection(selection_path, lines_per_page)
    excluded_files: list[dict[str, str]] = []
    if total_pages < SPLIT_THRESHOLD_PAGES:
        selection = read_json(selection_path) if selection_path is not None else {}
        items = selection.get("files", []) if isinstance(selection, dict) else selection
        listed_paths = {
            (project / str(item["path"])).resolve()
            for item in items
            if isinstance(item, dict) and item.get("path")
        }
        # 截断清单或确认后新增的源码不能被默认为完整范围之外。
        unlisted = [rel(path, project) for path in iter_source_files(project) if path.resolve() not in listed_paths]
        if unlisted:
            raise SystemExit(
                "STOP_FOR_USER\n"
                "NEXT_ACTION: 发现未列入源码候选清单的文件，请用 --max-files 0 重新生成完整候选清单并确认：\n"
                + "\n".join(f"- {name}" for name in sorted(unlisted))
            )
        unselected = [item for item in items if isinstance(item, dict) and item.get("path") and not item.get("selected")]
        prefix = "不属于申请软件："
        missing_reasons = [
            str(item["path"])
            for item in unselected
            if not str(item.get("model_reason") or "").strip().startswith(prefix)
            or not str(item.get("model_reason") or "").strip()[len(prefix):].strip()
        ]
        # 不足 60 页须提交完整源码；候选清单含无关文件时，由用户确认排除依据。
        if missing_reasons:
            raise SystemExit(
                "STOP_FOR_USER\n"
                "NEXT_ACTION: 已选源码不足 60 页，请补选属于申请软件的全部源码；"
                "不属于申请软件的候选文件请在 model_reason 中以“\u4e0d属于申请软件：具体原因”说明，"
                "然后重新确认代码选择。待处理文件：\n"
                + "\n".join(f"- {name}" for name in missing_reasons)
            )
        if unselected and (
            not isinstance(selection, dict)
            or not selection.get("user_confirmed")
            or not confirmation_is_current(selection)
        ):
            raise SystemExit(
                "STOP_FOR_USER\n"
                "NEXT_ACTION: 请核对全部源码和排除理由，重新执行 confirm_stage.py --stage code-selection。"
            )
        excluded_files = [
            {"path": str(item["path"]), "reason": str(item["model_reason"]).strip()}
            for item in unselected
        ]
    for stale_name in ("代码-前30页.md", "代码-后30页.md", "代码-全部.md"):
        (out_dir / stale_name).unlink(missing_ok=True)
    outputs: list[str] = []

    if total_pages >= SPLIT_THRESHOLD_PAGES:
        front = list(enumerate(pages[:30], start=1))
        back = [(31 + i, page) for i, page in enumerate(pages[-30:])]
        front_path = out_dir / "代码-前30页.md"
        back_path = out_dir / "代码-后30页.md"
        write_pages_md(front_path, "代码材料（前30页）", software_name, version, front)
        write_pages_md(back_path, "代码材料（后30页）", software_name, version, back)
        outputs.extend([front_path.name, back_path.name])
        mode = "front30_back30"
    else:
        all_path = out_dir / "代码-全部.md"
        all_pages = list(enumerate(pages, start=1))
        write_pages_md(all_path, "代码材料（全部）", software_name, version, all_pages)
        outputs.append(all_path.name)
        mode = "all_under_60_pages"
    supplement_status = (
        "已选源码达到前30页/后30页要求"
        if total_pages >= SPLIT_THRESHOLD_PAGES
        else "已选源码不足60页，按全部代码材料生成；未选候选的排除理由已确认"
    )

    manifest = {
        "software_name": software_name,
        "version": version,
        "project_root": str(project.resolve()),
        "file_count": len(files),
        "material_line_count": len(code_lines),
        "source_line_count": sum(item["source_line_count"] for item in files),
        "selected_source_line_count": sum(item["selected_line_count"] for item in files),
        "lines_per_page": lines_per_page,
        "max_code_columns": MAX_CODE_COLUMNS,
        "total_pages": total_pages,
        "submitted_page_count": 60 if total_pages >= SPLIT_THRESHOLD_PAGES else total_pages,
        "target_pages": SPLIT_THRESHOLD_PAGES,
        "available_candidate_line_count": available_lines,
        "available_candidate_pages": available_pages,
        "supplement_status": supplement_status,
        "mode": mode,
        "selection_file": str(selection_path) if selection_path else None,
        "outputs": outputs,
        "files": files,
        "excluded_files": excluded_files,
        "safe_software_filename": safe_filename(software_name),
    }
    write_json(out_dir / "代码提取清单.json", manifest)
    write_manifest_md(out_dir / "代码提取清单.md", manifest)
    return manifest


def main() -> None:
    """读取确认过的文件选择，生成源码分页和来源清单。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--analysis", help="Optional project analysis JSON; retained for workflow traceability")
    parser.add_argument("--software-name", required=True)
    parser.add_argument("--version", default="V1.0")
    parser.add_argument("--out-dir", default="软件著作权申请资料/草稿")
    parser.add_argument("--lines-per-page", type=int, default=LINES_PER_PAGE,
                        choices=range(CODE_MIN_LINES_PER_PAGE, LINES_PER_PAGE + 1))
    parser.add_argument("--selection", help="Editable JSON file created by propose_code_selection.py")
    args = parser.parse_args()

    project = Path(args.project)
    if not project.exists():
        raise SystemExit(f"Project not found: {project}")
    if args.analysis and not Path(args.analysis).exists():
        raise SystemExit(f"Analysis JSON not found: {args.analysis}")

    selection = Path(args.selection) if args.selection else None
    if selection and not selection.exists():
        raise SystemExit(f"Selection JSON not found: {selection}")

    manifest = extract(project, Path(args.out_dir), args.software_name, args.version, args.lines_per_page, selection)
    print(f"OK code drafts: {args.out_dir}")
    print(f"Selected files: {manifest['file_count']}")
    print(f"Mode: {manifest['mode']}")
    print(f"Total pages: {manifest['total_pages']}")
    print(f"Outputs: {', '.join(manifest['outputs'])}")


if __name__ == "__main__":
    main()
