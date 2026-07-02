#!/usr/bin/env python3
import csv
import contextlib
import io
import json
import os
import sys
import traceback
from collections import defaultdict
from pathlib import Path


def analyze_csv(path: Path):
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        for row in reader:
            rows.append(row)

    by_category_cents = defaultdict(int)
    warnings = []
    invoice_seen = set()
    for row in rows:
        amount = float(row.get("amount") or 0)
        category = row.get("category") or "未分类"
        invoice_no = row.get("invoice_no") or ""
        by_category_cents[category] += round(amount * 100)
        if amount <= 0:
            warnings.append({"invoice_no": invoice_no, "warning": "金额异常"})
        if invoice_no in invoice_seen:
            warnings.append({"invoice_no": invoice_no, "warning": "发票号重复"})
        invoice_seen.add(invoice_no)

    return {
        "row_count": len(rows),
        "by_category": {k: v / 100 for k, v in by_category_cents.items()},
        "warnings": warnings,
    }


def extract_xlsx(path: Path) -> str:
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    parts: list[str] = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        parts.append(f"## Sheet: {sheet_name}\n")
        max_cols = max(len(row) for row in rows)
        for i, row in enumerate(rows):
            cells = [str(cell) if cell is not None else "" for cell in row]
            cells += [""] * (max_cols - len(cells))
            parts.append("| " + " | ".join(cells) + " |")
            if i == 0:
                parts.append("|" + "|".join(["---"] * max_cols) + "|")
        parts.append("")
    wb.close()
    return "\n".join(parts)


def inspect_excel(path: Path):
    import openpyxl

    formula_wb = openpyxl.load_workbook(path, data_only=False, read_only=False)
    value_wb = openpyxl.load_workbook(path, data_only=True, read_only=True)

    workbook = {
        "file_name": path.name,
        "sheet_count": len(formula_wb.sheetnames),
        "sheets": [],
    }

    for sheet_name in formula_wb.sheetnames:
        ws = formula_wb[sheet_name]
        value_ws = value_wb[sheet_name]
        max_row = ws.max_row or 0
        max_column = ws.max_column or 0
        merged_ranges = [str(item) for item in ws.merged_cells.ranges]
        frozen_panes = str(ws.freeze_panes) if ws.freeze_panes else None

        header_row = []
        sample_rows = []
        formulas = []
        number_formats = {}

        for cell in next(ws.iter_rows(min_row=1, max_row=1, values_only=False), []):
            header_row.append(cell.value)

        sample_limit = min(max_row, 8)
        for row_index in range(2, sample_limit + 1):
            sample_rows.append([
                value_ws.cell(row=row_index, column=col_index).value
                for col_index in range(1, max_column + 1)
            ])

        for row in ws.iter_rows(max_row=min(max_row, 200), max_col=max_column, values_only=False):
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    formulas.append({
                        "cell": cell.coordinate,
                        "formula": cell.value,
                        "cached_value": value_ws[cell.coordinate].value,
                    })
                if cell.number_format and cell.number_format != "General":
                    number_formats[cell.coordinate] = cell.number_format
                if len(formulas) >= 80:
                    break
            if len(formulas) >= 80:
                break

        workbook["sheets"].append({
            "name": sheet_name,
            "rows": max_row,
            "columns": max_column,
            "headers": header_row,
            "sample_rows": sample_rows,
            "formula_count": sum(
                1
                for row in ws.iter_rows(values_only=True)
                for value in row
                if isinstance(value, str) and value.startswith("=")
            ),
            "formulas_sample": formulas[:25],
            "merged_ranges": merged_ranges,
            "frozen_panes": frozen_panes,
            "auto_filter": str(ws.auto_filter.ref) if ws.auto_filter and ws.auto_filter.ref else None,
            "number_formats_sample": dict(list(number_formats.items())[:40]),
        })

    formula_wb.close()
    value_wb.close()
    return workbook


def extract_docx(path: Path) -> str:
    from docx import Document

    doc = Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def extract_pptx(path: Path) -> str:
    try:
        from pptx import Presentation
    except ImportError:
        raise SystemExit("PPT 解析需要依赖未安装:pip install python-pptx")

    prs = Presentation(str(path))
    parts: list[str] = []
    for i, slide in enumerate(prs.slides, 1):
        texts = [
            shape.text_frame.text
            for shape in slide.shapes
            if shape.has_text_frame and shape.text_frame.text.strip()
        ]
        if texts:
            parts.append(f"--- Slide {i} ---\n" + "\n".join(texts))
    return "\n\n".join(parts)


def extract_pdf(path: Path) -> str:
    import pdfplumber

    parts: list[str] = []
    ocr_page_indices: set[int] = set()
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text()
            if text and text.strip():
                parts.append(f"--- Page {i + 1} ---\n{text}")
            else:
                ocr_page_indices.add(i)
    # 无文字层的页面(扫描件/手拍回单等)逐页抽最大内嵌图 OCR,避免混合 PDF 漏页。
    if ocr_page_indices:
        ocr_text = _ocr_pdf_pages(path, ocr_page_indices)
        if ocr_text:
            parts.append(ocr_text)
    return "\n\n".join(parts)


def _ocr_pdf_pages(path: Path, page_indices: set[int] | None = None) -> str:
    """图片型 PDF 兜底:pypdf 抽每页最大内嵌图(跳过 logo/印章小图)→ rapidocr OCR。"""
    from pypdf import PdfReader

    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        raise SystemExit("扫描件/图片型 PDF 的 OCR 需要依赖未安装:pip install rapidocr-onnxruntime")
    import numpy as np

    ocr = RapidOCR()
    reader = PdfReader(str(path))
    parts: list[str] = []
    for i, page in enumerate(reader.pages):
        if page_indices is not None and i not in page_indices:
            continue
        # 取该页面积最大的内嵌图 = 扫描主体,跳过 logo/印章/二维码等小图
        biggest = None
        biggest_area = 0
        for im in page.images:
            w, h = im.image.size
            if w * h > biggest_area:
                biggest_area = w * h
                biggest = im
        if biggest is None:
            continue
        arr = np.array(biggest.image.convert("RGB"))
        result, _ = ocr(arr, use_angle_cls=True)
        if not result:
            continue
        lines = sorted(result, key=lambda it: min(pt[1] for pt in it[0]))
        parts.append(f"--- Page {i + 1} (OCR) ---\n" + "\n".join(it[1] for it in lines))
    return "\n\n".join(parts)


def cmd_ocr_image():
    if len(sys.argv) < 3:
        raise SystemExit("usage: finance_worker.py ocr-image <path>")
    path = Path(sys.argv[2])
    if not path.exists():
        raise SystemExit(f"file not found: {path}")
    ext = path.suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise SystemExit(f"unsupported image type: {ext}")

    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        raise SystemExit("图片 OCR 需要依赖未安装:pip install rapidocr-onnxruntime")

    ocr = RapidOCR()
    # 手机拍的纸质单据常横拍/倒置;use_angle_cls 启用方向分类,自动摆正后再识别。
    result, _ = ocr(str(path), use_angle_cls=True)

    if not result:
        print("")
        return

    # result 是 list of [box, text, score]; 按 box 左上角 y 坐标从上到下排序
    def _top_y(item):
        box = item[0]
        return min(pt[1] for pt in box)

    lines = sorted(result, key=_top_y)
    text = "\n".join(item[1] for item in lines)
    print(text)


def cmd_extract_text():
    if len(sys.argv) < 3:
        raise SystemExit("usage: finance_worker.py extract-text <path>")
    path = Path(sys.argv[2])
    if not path.exists():
        raise SystemExit(f"file not found: {path}")
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xls"):
        text = extract_xlsx(path)
    elif ext == ".docx":
        text = extract_docx(path)
    elif ext == ".pptx":
        text = extract_pptx(path)
    elif ext == ".pdf":
        text = extract_pdf(path)
    else:
        raise SystemExit(f"unsupported file type: {ext}")
    print(text)


def cmd_inspect_excel():
    if len(sys.argv) < 3:
        raise SystemExit("usage: finance_worker.py inspect-excel <path>")
    path = Path(sys.argv[2])
    if not path.exists():
        raise SystemExit(f"file not found: {path}")
    if path.suffix.lower() not in (".xlsx", ".xlsm", ".xls"):
        raise SystemExit(f"unsupported file type: {path.suffix.lower()}")
    print(json.dumps(inspect_excel(path), ensure_ascii=False, indent=2, default=str))


def _next_versioned_path(path: Path) -> Path:
    """path 已存在则返回同目录下 stem_v2/_v3… 的首个空位,用于「不覆盖上一版产物」。"""
    if not path.exists():
        return path
    n = 2
    while True:
        cand = path.with_name(f"{path.stem}_v{n}{path.suffix}")
        if not cand.exists():
            return cand
        n += 1


def _install_overwrite_guard(output_path: Path, before_paths: set) -> None:
    """拦 openpyxl 保存,实现「回合感知」防覆盖(区分跨回答 vs 同一次回答内):
    - 目标是【本回合开始前就存在】的文件(上一轮产物 / 输入)→ 自动改存 _v2…,护住上一版;
      同一回合内对同一旧名的反复保存复用同一个新版本(只版本化一次,不堆 _v2_v2…)。
    - 目标是【本回合内新建】的文件 → 直接覆盖(同一次回答收敛到一个文件,不再版本化)。
    这样:跨回答不冲掉上次产物,回合内不循环出多版本——也消除「静默改存→自己读回旧文件」的自欺。
    只动 output_dir 内的目标;其它路径照常。"""
    try:
        import openpyxl
    except Exception:
        return
    _orig_save = openpyxl.Workbook.save
    root = str(output_path.resolve())
    redirect = {}  # 旧名(resolve) -> 本回合内为它分配的新版本名(str),复用以避免每次再 +1

    def _guarded_save(self, filename):
        try:
            target = Path(filename)
            if not target.is_absolute():
                target = output_path / target
            target = target.resolve()
            if not str(target).startswith(root):
                # 目标在 output_dir 之外 → 重定向到输出目录同名,防产物逃逸丢失
                name = target.name
                target = (output_path / name).resolve()
                print(f"已重定向到输出目录:{name}")
            # 回合感知版本化判断(对重定向进来的目标同样适用)
            if target in redirect:  # 本回合已为此旧名分配过新版 → 复用(覆盖那一个新版)
                return _orig_save(self, redirect[target])
            if target.exists() and target in before_paths:  # 上一轮产物/输入 → 版本化一次
                newp = str(_next_versioned_path(target))
                redirect[target] = newp
                return _orig_save(self, newp)
            # 本回合内新建(或全新文件)→ 直接覆盖/创建,不版本化
            return _orig_save(self, str(target))
        except Exception:
            pass
        return _orig_save(self, filename)

    openpyxl.Workbook.save = _guarded_save


def cmd_run():
    output_dir = os.environ.get("FINANCE_AGENT_OUTPUT_DIR")
    if not output_dir:
        raise SystemExit("FINANCE_AGENT_OUTPUT_DIR environment variable is required")
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # 快照:路径 -> (mtime_ns, size),事后据此识别「新建」和「被改写」的产物
    before = {}
    for p in output_path.iterdir():
        if p.is_file():
            st = p.stat()
            before[p.resolve()] = (st.st_mtime_ns, st.st_size)

    code = sys.stdin.read()
    if not code.strip():
        raise SystemExit("no code provided on stdin")

    # 防覆盖守卫的版本化基线 = 「本回合开始前」就存在的文件,而非「本次 run_python 调用前」。
    # 否则同一回合里先建的文件,对后一次调用(独立 worker 进程、各拍各的 before)就成了"上一版",
    # 会被误加 _v2(实测缺陷:agent 跨多次调用存同名 → 第二次被改成 _v2)。回合基线由 run-python.ts
    # 在工具工厂(每回合一次)快照后经 env 传入;无该 env(直接跑 worker/测试)则回落到调用前快照。
    turn_before_env = os.environ.get("FINANCE_AGENT_TURN_BEFORE")
    if turn_before_env:
        try:
            names = json.loads(turn_before_env)
            guard_before = {(output_path / n).resolve() for n in names if isinstance(n, str)}
        except Exception:
            guard_before = set(before)
    else:
        guard_before = set(before)
    _install_overwrite_guard(output_path, guard_before)  # 回合感知防覆盖:护上一版、回合内覆盖自己(含跨多次调用)

    namespace = {"output_dir": str(output_path), "Path": Path}
    captured_stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured_stdout):
            exec(code, namespace)
    except Exception:
        trace_id = os.environ.get("FINANCE_AGENT_TRACE_ID") or "?"
        sys.stderr.write(f"[trace_id={trace_id}] ")
        traceback.print_exc(file=sys.stderr)
        raise

    # 新建 或 被改写(mtime/size 变化)都算产物 —— 堵「覆盖已存在文件→集合差识别不到→更新隐身」
    files_out = []
    for p in sorted(output_path.iterdir(), key=lambda x: x.name):
        if not p.is_file():
            continue
        st = p.stat()
        prev = before.get(p.resolve())
        is_new = prev is None
        is_modified = prev is not None and (st.st_mtime_ns, st.st_size) != prev
        if is_new or is_modified:
            files_out.append({
                "name": p.name,
                "path": str(p.resolve()),
                "size_bytes": st.st_size,
                "mime_type": _guess_mime(p.suffix),
                "changed": "new" if is_new else "modified",
            })

    result = {
        "stdout": captured_stdout.getvalue(),
        "files": files_out,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


def _guess_mime(suffix: str) -> str:
    mapping = {
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".csv": "text/csv",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".html": "text/html",
    }
    return mapping.get(suffix, "application/octet-stream")


def demo():
    demo_file = get_demo_data_path()
    demo_file.parent.mkdir(parents=True, exist_ok=True)
    if not demo_file.exists():
        demo_file.write_text(
            "employee,expense_date,invoice_no,category,amount\n"
            "张敏,2026-05-12,INV-001,交通,380\n"
            "李哲,2026-05-14,INV-002,招待,1680\n"
            "王岚,2026-05-15,INV-001,办公,260\n",
            encoding="utf-8",
        )
    return analyze_csv(demo_file)


def get_demo_data_path():
    if os.environ.get("FINANCE_AGENT_DEMO_DATA_PATH"):
        return Path(os.environ["FINANCE_AGENT_DEMO_DATA_PATH"])
    if os.environ.get("FINANCE_AGENT_APP_DATA_DIR"):
        return Path(os.environ["FINANCE_AGENT_APP_DATA_DIR"]) / "demo_reimbursements.csv"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "finance-agent" / "demo_reimbursements.csv"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "finance-agent" / "demo_reimbursements.csv"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "finance-agent" / "demo_reimbursements.csv"


def cmd_selfcheck():
    # 首启环境自检:报告 Python 版本与关键依赖是否就位(供桌面端 doctor 用人话提示用户)。
    deps = ["openpyxl", "pandas", "pdfplumber", "xlsxwriter", "pypdf", "reportlab", "docx", "pptx", "lxml", "PIL", "defusedxml", "pdf2image", "markitdown"]
    found = {}
    missing = []
    for name in deps:
        try:
            module = __import__(name)
            found[name] = getattr(module, "__version__", "unknown")
        except Exception:
            missing.append(name)
    print(json.dumps({
        "python": sys.version.split()[0],
        "deps": found,
        "missing": missing,
        "ok": len(missing) == 0,
    }, ensure_ascii=False))


def _force_utf8_stdio():
    """把 stdin/stdout/stderr 统一改成 UTF-8。Windows 中文系统默认 cp936/GBK:Node 按 UTF-8 把
    code 写进 stdin → sys.stdin.read() 误解码出游离代理(\\udcXX)→ exec/print 报 "surrogates not
    allowed"。在读 stdin / 任何 print 之前调用。与 run-python.ts 的 PYTHONUTF8=1 双保险:即便 worker
    被直接运行/测试(没设那个 env)也正确。"""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass  # 非常规流(如已被替换为 StringIO)忽略


def main():
    _force_utf8_stdio()
    if len(sys.argv) >= 2 and sys.argv[1] == "--selfcheck":
        cmd_selfcheck()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "demo":
        print(json.dumps(demo(), ensure_ascii=False, indent=2))
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "ocr-image":
        cmd_ocr_image()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "extract-text":
        cmd_extract_text()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "inspect-excel":
        cmd_inspect_excel()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "run":
        cmd_run()
        return
    if len(sys.argv) == 3 and sys.argv[1] == "analyze-csv":
        print(json.dumps(analyze_csv(Path(sys.argv[2])), ensure_ascii=False, indent=2))
        return
    raise SystemExit(
        "usage: finance_worker.py --selfcheck | demo | analyze-csv <path> | extract-text <path> | inspect-excel <path> | ocr-image <path> | run"
    )


if __name__ == "__main__":
    main()
