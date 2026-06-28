---
name: contract-extract
description: 上传合同/订单/发票/票据类文档后，提炼关键要点写入知识库结构化 metadata（draft）。触发条件：用户上传合同、订单、发票、账单、水电费单等应付应收相关文档，且文档已进入知识库（有 documentId）。不上传文档时不要触发。输出：调用 record_document_metadata 写 draft；绝不替用户确认（confirmed 由用户在目录页操作）。
---

# 合同/单据要点提炼

面向 1-4 人财务团队：把合同、订单、发票、票据里的关键财务义务提炼成结构化 metadata，写入知识库 draft，供用户核对确认。

## 核心原则（必须遵守）

1. **确定性优先，零模型心算**：结构化文档（订单 Excel/带表头表格）用 `run_python` + openpyxl/pandas 按列取数，不让模型猜；非结构化 PDF/Word 才过模型。
2. **拿不准留空，绝不编造**（红线 4）：金额、日期、对方名称只要有一点不确定，就填 `null`，在回复里说明"未找到"，绝不估算。
3. **全程本地**（红线 7）：提炼过程在本机完成；写入 metadata 的只有提炼结果（docType/counterparty/amount/keyDates 等），不含敏感原文段落。
4. **draft ≠ confirmed**（红线 3）：写完 draft 必须明确告知用户"已起草，请在知识库目录确认"，不要代替用户确认。

## 何时做什么

| 文档类型 | 提炼策略 |
|---|---|
| Excel 订单/台账 | `run_python` + pandas 按表头取数：金额列、日期列、对方列，零模型 |
| PDF 合同/协议 | 先用 `query_knowledge` ripgrep 定位「付款」「金额」「甲方」「乙方」「到期」段，只把命中段送模型，不发全文 |
| Word (.docx) | `read_file` 取全文或 ripgrep 定位关键段，再提炼 |
| 图片发票 | `run_python` pdfplumber 或 OCR 提取文字，再结构化 |
| 水电/物业账单 | 通常只有金额/日期，其余留空 |

## 提炼字段说明

```
docType       合同/订单/发票/水电/票据…（1-2字概括）
counterparty  对方公司名（甲方/乙方，只取确定的那一方）
amount        金额（元，整数或两位小数）；不确定→ null
amountCurrency 默认 CNY；有外币时填实际货币代码
keyDates      [{ kind: "签订"|"付款"|"开票"|"到期"|"交付", date: "YYYY-MM-DD" }]
recurrence    一次/月/季/年/分期；拿不准→ null
status        待付/已付/待开票/已开票/待收/已收；拿不准→ null
sourceFile    文件名（从上传信息直接取）
fields        每类卡片附加字段（如订单号、项目名、是否交付），JSON
```

## 执行流程

1. 确认触发：用户上传了合同/订单/发票/票据，且已有知识库 documentId。
2. 按文档类型选策略（见上表）。
3. 定位关键段：优先用 `query_knowledge`（rg 命令）而非发全文给模型。
4. 提炼字段：拿不准的 **必须留 null**，不猜不估。
5. 调用 `record_document_metadata` 写 draft（传 documentId + metadata）。
6. 回复用户：「已提炼×××要点，写入草稿。请在知识库→文档目录确认后生效。」列出提炼到的字段，标注哪些未找到。

## 禁止事项

- 不替用户调 PATCH confirmed（confirmed 只能用户在前端操作）
- 不发合同原文全文给模型（长合同先 ripgrep 定位再发片段）
- 不把身份证号/银行卡号等原样写进 metadata（先脱敏/打码）
- 不在 amount 里填模糊区间（如"约 10 万"），宁可留 null
