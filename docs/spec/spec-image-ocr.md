# Spec:知识库图片本地 OCR(RapidOCR,进 python worker)

## 背景与决策
知识库上传 accept 含图片(`.png/.jpg/.jpeg/.webp`),但 `parseDocument`(`lib/knowledge/parsers/index.ts`)无图片分支 → 图片入库报「不支持的文件类型」。用户选了**本地 OCR(路 B)**——理由:财务 + 本地优先 + **红线 7(图片可能含敏感信息,不能外发)**。后续质量不够再换 Claude 视觉(路 A),本期不做 A。

## 现状(已查证)
- worker `workers/finance_worker.py`:命令式分发(`main()` 里 `extract-text`/`inspect-excel`/`run`/`analyze-csv` 等);依赖**惰性 import**(如 `def extract_pdf: import pdfplumber`)——缺包只让该命令失败,不影响其它。
- `parseDocument` 的 PDF 分支走 `execFileSync(getPythonPath(), [finance_worker.py, "extract-text", path])`。
- 仓库根 `fd requirements.txt` **没找到**——python 依赖声明/安装机制需先定位(见任务 1)。

## 任务

### 1. 依赖声明 + 安装
- **已查到的线索**(别重复全盘搜):`scripts/prepare-tauri.mjs:92/96` 提到打包时 `pip install -r requirements.txt` 进 `workers/python-runtime`(可重定位 Python);`lib/agent/mcp-tools/run-python.ts` 有依赖引用;但**仓库里目前没有 requirements.txt**。可能现状是 dev 手动装进 `workers/.venv` + 打包首启下载兜底。
- 处理:**建 `workers/requirements.txt`**(含现有 pdfplumber/openpyxl/pandas 等——按 worker 里实际 import 的列全 + 新增 **`rapidocr-onnxruntime`**),并确认 `prepare-tauri.mjs` 的打包流能用上它(它已引用该文件名,补上文件即可让"免首启下载"路径成立)。别破坏现有首启安装兜底。
- RapidOCR 的 ONNX 模型**随 wheel 自带**(无需额外下载),离线可用——契合本地优先。
- 在本 worktree 的 venv 里**真的 `pip install rapidocr-onnxruntime`**(worktree 的 `workers/.venv` 是 symlink 到主 checkout 的,装一次即真实可用),以便 AC1 真跑验证。

### 2. worker 加 `ocr-image` 命令(`workers/finance_worker.py`)
- 仿 `cmd_extract_text` 加 `cmd_ocr_image()` + 在 `main()` 注册 `ocr-image`。
- **惰性 import**:`from rapidocr_onnxruntime import RapidOCR`;`ImportError` → `raise SystemExit("图片 OCR 需要依赖未安装:pip install rapidocr-onnxruntime")`(优雅降级、信息可操作)。
- 跑 OCR:对传入图片识别,按从上到下(可按 box y 排序)**拼接识别出的文本行**,`print(text)`。识别为空就输出空串(交给 TS 侧判「内容为空」)。
- 支持 `.png/.jpg/.jpeg/.webp`(RapidOCR 经 PIL/opencv 读;webp 若需 PIL 支持一并确认)。

### 3. `parseDocument` 加图片分支(`lib/knowledge/parsers/index.ts`)
- 在最终 `throw 不支持` 之前加:`image/png` / `image/jpeg` / `image/webp` /(可选 `image/gif`)→ `parseImageDocument(filePath)`。
- `parseImageDocument` 仿 `parsePdfDocument`:`execFileSync(getPythonPath(), [finance_worker.py, "ocr-image", filePath])` 取 stdout 文本。
- worker 失败(如缺依赖、退出码非 0)→ 抛**可操作错误**(把 worker stderr 透出,如「图片识别失败:OCR 依赖未安装,请…」),让上传 UI 显示得了。
- 不外发(红线 7):全程本机 worker,绝不发图片到任何网络。

### 4. 前端
- accept 已含图片,**无需改**;图片入库现在能真正解析了。空 OCR 结果时 `ingestDocument` 现有「文档内容为空」校验会拦——确认错误信息对图片也说得通(没识别到文字)。

## 红线 / 约束
- **红线 7**:OCR 全本地,图片绝不外发。
- 沿用 worker 惰性 import + execFileSync 模式;不引入网络调用;不改既有 PDF/docx/xlsx 解析。
- 最小改动:`finance_worker.py` + `parsers/index.ts` + 依赖声明(+ 必要时 requirements/installer 接线)。

## 验收(AC)
- **AC1** `finance_worker.py ocr-image <png/jpg>` 能输出图中文字(**真跑验证**:造一张含中文/数字的测试图,OCR 出对应文本)。
- **AC2** 缺 `rapidocr-onnxruntime` 时,worker 报可操作错误、不崩;TS 侧把它透成上传可读的失败信息。
- **AC3** `parseDocument` 对 `image/png|jpeg|webp` 走 OCR;其它不支持类型仍报原错误。
- **AC4** 图片入库走通:OCR 文本 → `ingestDocument` → 文本镜像 + ripgrep 可检索(可用现有知识库测试链路或新测试验证一条)。
- **AC5** 红线 7:确认无任何网络外发(纯本地 worker)。
- **AC-test/typecheck/lint** 全绿(`# fail` 0,pptx/secret-store 既有告警忽略,lint 0 error)。

## 测试
- `tests/` 加 OCR 测试,但**对依赖可用性 guard**:`rapidocr-onnxruntime` 不可用时 **skip 真跑那条**(打印 skip),始终跑的是:`parseDocument` 对 image mime **路由到 ocr-image worker 命令**(可 mock execFileSync 或断言走到图片分支)、以及缺依赖时的优雅错误。真 OCR(AC1)你在 worktree 装好依赖后跑一次贴结果。
- wire 进 `tests/all.test.ts`。

## 文件
- `workers/finance_worker.py`(`cmd_ocr_image` + main 注册)
- `lib/knowledge/parsers/index.ts`(图片分支 + `parseImageDocument`)
- python 依赖声明(定位后追加 `rapidocr-onnxruntime`)
- `tests/ocr-image.test.ts`(+ all.test.ts)

## 不做(本期边界)
- Claude 视觉 OCR(路 A);图片脱敏;表格结构还原 / 版面分析;PDF 内嵌图片 OCR。
