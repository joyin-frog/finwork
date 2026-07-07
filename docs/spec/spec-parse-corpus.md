# 脏文件语料库（WP11：解析回归资产 + PII 门控 + analyze-csv 静默修复）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审仅剩 §1 第 4 条旧措辞一处（与 orchestrator 修复赛跑），已对齐并清 §3/§5 残留，按"对齐即批准"条款生效）
> 状态：已批准
> 依赖：无。零 DDL。
> 架构事实（2026-07-07 scout 核实）：解析面——TS 入口 `parseDocument`（lib/knowledge/parsers/index.ts，按 mimeType 分发：txt/md 直读、docx=mammoth、xlsx=exceljs buildSpreadsheetMirror、**.xls 抛"暂不支持旧版 .xls"**、pdf/pptx/图片走 finance_worker.py extract-text/ocr-image、未知类型抛错）；Python 侧 extract-text 按后缀分发（pdf 文字层空自动 OCR fallback）、inspect-excel（限扫前 80 公式/200 行）、**analyze-csv 硬编码列名 amount/category/invoice_no（finance_worker.py:16-27），列名不匹配静默返回 0/空——红线问题**。既有 fixtures：tests/fixtures/ 仅 3 个 xlsx（批注/图表两个即历史崩溃 bug 的回归样本，模式成熟）+ golden fixtures 6 个 md；无 csv/pdf/图片样本。历史 bug：xlsx 批注崩溃、图表崩溃（有 fixture 回归）、csv float 漂移（临时文件回归无 fixture）、PDF/OCR/乱码零覆盖。**路线定案 A**：语料放 tests/fixtures/corpus/，node 测试直喂解析函数（xlsx-sanitize.test.ts 是成熟样板），零基建改动；golden runner 无附件注入口且不在 CI（否决路线 B）。PII 防线现状：safety-redaction.test.ts 只护落盘路径，**fixture 文件本身无门控**。eval:golden:ci 脚本定义了但 CI 无 job 调用（记 roadmap 待办，不在本刀）。

## 0. 目标与非目标

**目标**：把"解析鲁棒性"从踩坑驱动变成回归资产：① `tests/fixtures/corpus/` 落首批合成脏样本（全部程序生成，零真实数据）；② `tests/parse-corpus.test.ts` 逐样本喂真实解析函数断言行为（内容命中或**明确中文报错**——拒绝路径不许静默）。**GBK 样本的预期行为定案（reviewer A1）**：Node readFileSync utf-8 对 GBK 字节静默替换 U+FFFD——乱码静默入库违反红线，因此本刀在 `parseDocument` 的 text/* 分支补**编码检测**：读出内容含 `\uFFFD` 即抛中文错误（"文件编码可能不是 UTF-8（常见为 GBK），请用 Excel/记事本另存为 UTF-8 后重传"）；GBK 样本断言=抛出且错误含"编码"引导（拒绝路径，非乱码锚点）；③ **语料 PII 自动门控**：测试对 corpus 全部文本类文件跑 `lib/safety/pii.ts` 的 redact，输出与原文不一致（发生了脱敏替换）即红——语料永远不含 PII 由机器保证；④ 修 analyze-csv 静默缺陷：列名不匹配时返回显式 **`column_warnings` 列表字段**（reviewer B3 与既有行级 `warnings` 区分；内容如"未找到金额列（amount），已识别列：…"），不再静默。**设计理由（reviewer B4）**：选"结构化返回+解释"而非直接报错——row_count/已识别列名对诊断有价值，且带解释的部分结果与 filing-precheck 的"无法核验"同型（有解释即非静默）；直接报错会把"半可用的脏文件"一刀切死，违背解析鲁棒性主旨；⑤ `corpus/README.md` 落纪律："修解析 bug 必须先在本目录落触发样本+红测试"。

**非目标**：真实用户文件入库（合成样本足够覆盖结构性脏；真实样本等用户脱敏提供）；golden runner 附件注入（路线 B 否决）；PDF/OCR 深度样本（合成 PDF 依赖重，v1 只放"空文字层触发 OCR fallback"一个最小 PDF，生成不便则记 README 待补并在测试 skip 注明）；eval:golden:ci 接入 CI（独立小事记 roadmap）。

## 1. 成功标准（先红后绿）

- [ ] 首批语料 ≥9 个合成样本（脚本生成进 corpus/，生成脚本本身入库 corpus/gen/ 供再生）：xlsx×3（歪表头非首行 / 合并单元格 / 多 sheet 且首 sheet 空）、csv×4（GBK 编码中文 / 列名别名"金额/类目/发票号" / 千分位与货币符号金额 / 列名完全不匹配）、xls×1（触发拒绝路径）、未知扩展名×1（触发拒绝路径）。
- [ ] `tests/parse-corpus.test.ts`：每样本一组断言——可解析样本断言关键内容出现在解析输出（如合并单元格样本的跨行值）；拒绝样本断言抛出且错误为中文引导：GBK csv→含"编码"（新检测路径）、.xls（测试传 mimeType `application/vnd.ms-excel`）→含"不支持"、未知扩展（传 `application/octet-stream`）→含"不支持的文件类型"（reviewer B5 的 mimeType 指定）。**绝不接受静默空结果**。
- [ ] `parseDocument` text/* 分支编码检测（reviewer A1）：内容含 U+FFFD → 抛中文引导错误；纯 UTF-8 文件（含 BOM）不受影响（utf-8-sig 场景由 analyze-csv 的 python 侧已处理，TS 侧 BOM 剥离现状不变——若现状 BOM 会残留进 mirror，加一个 BOM 样本记录现状为锚点，不在本刀修）。
- [ ] **PII 门控断言**：遍历 corpus 全部文本可读文件（csv/生成脚本；xlsx 取 mirror 文本），`redact(text)===text` 必须成立。**假阳性规避（reviewer B1）**：gen 脚本生成的一切数字禁用"1[3-9] 开头的 11 位连续数字"等 PII 形态——发票号统一 `INV-` 前缀、金额带小数点、日期带连字符；README 写入此规避规则。
- [ ] analyze-csv 修复：现有返回 `{row_count, by_category, warnings}` **追加 `column_warnings: string[]`**（缺哪列进哪条，如"未找到金额列（amount），已识别列：<实际列名>"）；对应语料样本（列名完全不匹配）断言 **`by_category` 为空或全 0 且 `column_warnings` 非空**（reviewer A2：现结构无 total 字段，旧措辞撤销）。python 侧改动限 analyze_csv 函数；tests/python-worker.test.ts 既有断言涉及则同步（物理断言规则）。
- [ ] `corpus/README.md`：命名规范（`<解析器>-<症状>.<ext>`）、纪律条款、PII 红线（门控测试自动执行）、再生方式。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `tests/fixtures/corpus/`（目录+9 样本+gen/ 生成脚本+README.md） | 新增 | 首批语料 |
| `tests/parse-corpus.test.ts` | 新增 | 逐样本断言 + PII 门控 |
| `lib/knowledge/parsers/index.ts` | 修改 | text/* 分支编码检测（U+FFFD→中文引导抛错，reviewer A1） |
| `workers/finance_worker.py` | 修改 | analyze_csv 加 column_warnings（仅此函数） |
| `.gitattributes` | 新增 | corpus 目录二进制/禁换行转换标注（reviewer B2——git 对 csv 默认按文本处理，Windows autocrlf 会破坏 GBK 字节，非可选） |
| `tests/python-worker.test.ts` | 修改（如既有断言涉及） | analyze-csv 断言同步 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 写生成脚本产出样本（xlsx 用 exceljs 生成——与解析器同库生成能精确构造症状；csv 直接 Buffer 写含 GBK 的用 iconv? **不引依赖**：GBK 样本用 Python 一次性生成入库（gen/ 脚本用 finance_worker 的 python 环境跑），或 Node Buffer 写死字节序列）。
2. 红测试（样本在而断言先红：analyze-csv column_warnings 断言与 GBK 编码检测断言在修复前红；其余样本断言按现状可能即绿——**对"现状即绿"的样本如实标注为回归锚点而非 TDD 红**，audit 说明）。
3. analyze_csv 修复转绿。
4. PII 门控 + README。
5. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **GBK 样本的仓库存储**：`.gitattributes` 已定案进 Files touched（`tests/fixtures/corpus/** -text` 或等价，禁换行转换保字节）。
- analyze-csv 的 column_warnings 是新增字段——消费方（工具层 structuredContent 透传）向后兼容（加字段不破坏），grep 消费方确认无严格 schema 校验拦截。
- 被否决：① 路线 B golden 附件注入（改 runner 成本高且不在 CI）；② 引 iconv-lite 生成 GBK（依赖纪律，一次性生成入库即可）；③ 真实脏文件首批入库（脱敏责任重，合成样本先行）。
