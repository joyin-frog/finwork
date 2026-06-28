# Spec: P1 合同归纳 = 知识库结构化目录

> 状态：待审阅
> 日期：2026-06-21
> 范围：把知识库从"全文检索"升级为"全文检索 + 可筛选的结构化目录"。先读 `spec-finance-shared-contract.md`。

---

## 背景

1–4 人财务团队最大痛点：付款/收款/开票义务散落在合同/订单/单据里，没有"何时该付/该收/该开"的单一视图。知识库现在只做"备查"（文本镜像 + ripgrep），缺**结构化、可筛选的目录**。本功能补上这层——做成**从文档提炼义务的通用登记表**，不是"订单履约跟踪器"（那是这家公司的业务味，不通用）。

骨架已有：`KnowledgeDocument`（`lib/knowledge/types.ts`）+ 类目自动归类（`lib/knowledge/category.ts`：合同/税务/报销政策/财务规范/通用）+ `updateKnowledgeDocumentMetadata`（`lib/db/sqlite.ts`）+ `app/api/knowledge/documents/[id]` PATCH + 知识库页（`app/knowledge/page.tsx`，582 行，已有类目筛选/上传/预览/搜索/删除）。**本功能是补丁不是重建。**

## ① 数据 / schema

- `knowledge_documents` 加两列（`lib/db/schema.ts`，ALTER 守卫幂等）：
  - `metadata TEXT`（JSON，提炼字段）
  - `meta_status TEXT DEFAULT 'none'`（`none` | `draft`(待确认) | `confirmed`(已确认)）
- `KnowledgeDocument` 类型加 `metadata?: DocMetadata`、`metaStatus`。
- **DocMetadata 形状**：通用书脊（写死）+ 每类卡片（灵活）：
  ```ts
  type DocMetadata = {
    docType?: string;        // 合同/订单/发票/水电/票据…
    counterparty?: string;   // 对方（甲/乙方择一或两列）
    amount?: number;         // 金额(元)
    amountCurrency?: string; // 默认 CNY
    keyDates?: { kind: "签订"|"付款"|"开票"|"到期"|"交付"; date: string }[];
    recurrence?: "一次"|"月"|"季"|"年"|"分期";
    status?: string;         // 待付/已付/待开票/已开票/待收/已收…（业务状态，区别于 meta_status）
    sourceFile?: string;     // 来源文件名
    fields?: Record<string, unknown>; // 每类卡片的灵活附加字段（订单号/事业部/是否交付…）
  };
  ```
  - **通用书脊**（docType/counterparty/amount/keyDates/recurrence/status/sourceFile）写死、人人都有。
  - **每类卡片**进 `fields`（灵活 JSON），按 docType 自适应，**不给库表加列**。

## ② 工具签名 + 注册

- `lib/agent/mcp-tools/document-metadata.ts`：
  - `record_document_metadata({ documentId, metadata, status })` —— 起草/更新某文档的 metadata，写 `meta_status='draft'`。`withIdempotency(..., { riskLevel: "medium" })`。
  - confirm 由前端 PATCH 走（见④），不单独做工具。
- 注册：registry / index / renderers / system-prompt 各追加一行（见共享契约 §1、§3）。renderer 例：`record_document_metadata: (i)=> \`提炼「\${docType}」要点\``。
- system-prompt 追加一条：自动起草后**不冒充已确认**，提炼不准/拿不准的字段留空并说明（红线 4）。

## ③ Skill

`agent-skills/skills/contract-extract/SKILL.md`（新）：
- 触发：上传应付应收相关类目文档（合同/订单/发票/票据）时提炼要点。
- **确定性优先**：结构化文档（订单 Excel/带表头表）用 `run_python` 解析器**按列取数，零模型**；非结构化 PDF/Word 合同才过模型；长文先 ripgrep 定位"付款/金额/甲乙方"段只送相关段。**不上向量**。
- 提炼后调 `record_document_metadata` 写 draft；**金额/日期拿不准就标空 + 说明，不编**（红线 4）。
- 全程本地提炼，**不外发**（红线 7）。

## ④ 前端（本功能的大头）

扩 `app/knowledge/page.tsx`（**不新建页**）：
- **目录表格视图**：每行展示 metadata 书脊字段（对方/金额/到期日/状态），不止标题/类目。
- **状态徽章**：draft（待确认，醒目）/ confirmed（已确认）。
- **确认/编辑面板**：点开看提炼字段卡片、可改、点"确认"→ PATCH `app/api/knowledge/documents/[id]`（扩为可写 metadata + 置 `meta_status='confirmed'`）。
- **筛选扩展**：现有只按类目；加金额区间 / 到期日 / 状态筛选。
- 自动起草触发：上传后异步起一次提炼（限应付应收类目），完成后该行变 draft 待确认。

## ⑤ 红线护栏

- **4**：draft≠confirmed，**只认 confirmed**；提炼不准留空不编。
- **3**：meta_status 状态分明（draft/confirmed）。
- **7**：提炼全本地，metadata 不含需外发的敏感原文。

## ⑥ MVP 边界

- **做**：metadata 列 + 起草/确认工具 + contract-extract skill + 目录表格/筛选/确认面板。
- **后置**：付款/收款**提醒**、**资金日历**（到期日+状态是其种子，本期只存不提醒）；向量检索（明确不做）。
