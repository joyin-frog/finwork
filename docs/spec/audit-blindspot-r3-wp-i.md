# Audit: blindspot-fixes-r3 WP-I 金蝶工具收口

## Files changed

- `lib/agent/mcp-tools/kingdee-tools.ts` — 修改（描述矛盾收口 + 代码注释 + 5处摘要长度上限）
- `tests/kingdee.test.ts` — 修改（新增 T6/T7 两个测试，增加 z import）

---

## 每处改动与 spec 对应

### WP-I 条 1：工具描述矛盾收口

**spec 要求**：`build_voucher_sheet`（约 673 行）描述删除"用 run_python(openpyxl) 写成 xlsx"指引，改为"仅用于向用户预览凭证行数据；生成交付 xlsx 必须用 export_voucher_list"。同步更新约 394 行的代码注释（"实际 xlsx 由 run_python 写"已过时）。

**实际改动**：

1. `lib/agent/mcp-tools/kingdee-tools.ts` 约 394 行注释：
   - 旧：`// ── 凭证 → 金蝶对照手填清单(行数据,列对齐录入界面);实际 xlsx 由 run_python 写 ──`
   - 新：`// ── 凭证 → 金蝶对照手填清单(行数据,列对齐录入界面);仅用于预览，实际 xlsx 由 export_voucher_list 生成 ──`

2. `sdk.tool("build_voucher_sheet", ...)` 描述：
   - 旧末尾：`...借贷分列)。拿到后用 run_python(openpyxl)写成 xlsx 交付。`
   - 新末尾：`...借贷分列)。仅用于向用户预览凭证行数据；生成交付 xlsx 必须用 export_voucher_list。`

3. `export_voucher_list` 描述中保留了"禁止用 run_python+openpyxl 手拼凭证行"——这是禁止指令，方向一致，无需改动。

**验证**：`grep -n "run_python" kingdee-tools.ts` 确认仅剩 `export_voucher_list` 的禁止性描述，`build_voucher_sheet` 描述中无 "run_python"。

---

### WP-I 条 2：摘要长度上限

**spec 要求**：凭证分录的 `summary` zod schema 全部凭证相关处加 `.max(100, "摘要超长（金蝶上限约100字符），请精简")`。

**grep 全量排查**：执行 `grep -n "summary: z\.string()"` 发现 6 处：

| 行号 | 所属 schema | 是否凭证分录 | 处理 |
|------|------------|------------|------|
| 42 | `exportDraftEntrySchema` | ✓ | 加 .max(100) |
| 371 | `buildVoucherSchema.expenses` | ✓ | 加 .max(100) |
| 403 | `buildSheetSchema.lines` | ✓ | 加 .max(100) |
| 432 | `batchSchema.slips.lineItems` | ✓ | 加 .max(100) |
| 533 | `exportVoucherListSchema.vouchers.lines` | ✓ | 加 .max(100) |
| 552 | `exportVoucherListSchema.skipped` | ✗（跳过文档元信息） | 不改 |

第 552 行是被跳过单据的元信息描述字段，不属于凭证分录摘要，不加约束。

---

### WP-I 条 3：测试

**spec 要求**：超长摘要（>100 字符）被 schema 拒绝且错误信息含"精简"；`build_voucher_sheet` 描述断言不含 "run_python"。

**实现**：在 `tests/kingdee.test.ts` 添加 T6/T7：

- T6：创建捕获 description 的 mockSdk，断言 `descsT6.get("build_voucher_sheet")` 不含 `"run_python"`
- T7：捕获 `export_kingdee_draft` schema，用 `z.object(schema).safeParse()` 传入 101 字符摘要，断言 `success === false` 且 error.issues 中含"精简"

---

## 先红后绿证据

**红（改动前）**：

```
kingdee: 科目表数据驱动(示例兜底 / 导入清洗 / 校验对照真表 / import 工具 / 维度保留)✓
AssertionError [ERR_ASSERTION]: T6 FAIL: build_voucher_sheet 描述不应含 run_python，
实际：...拿到后用 run_python(openpyxl)写成 xlsx 交付。
Exit code 1
```

（T7 因 T6 失败而未执行，但改动前描述包含 run_python 且 schema 无 .max(100) 均会导致失败）

**绿（改动后）**：

```
kingdee: 科目表数据驱动(示例兜底 / 导入清洗 / 校验对照真表 / import 工具 / 维度保留)✓
kingdee: T6 build_voucher_sheet 描述防回归 ✓
kingdee: T7 摘要长度上限校验 ✓
Exit code 0
```

---

## 与 spec 偏差及理由

无偏差。

唯一说明：`exportVoucherListSchema.skipped.summary`（第 552 行，`z.string().optional()`）未加 `.max(100)`。spec 表述为"凭证分录的 summary"，该字段是被跳过文档的附注说明，不是凭证分录摘要。已在全量 grep 表中标注并保留原样。

---

## 开放风险

- TypeScript `tsc --noEmit` 对 `tests/kingdee.test.ts` 报 4 个预存错误（`.ts` 扩展名引入路径 + handler 类型窄化），均是项目基线既有问题，未被此次改动引入。项目使用 `tsx` 运行测试，不受影响。
- `summary: z.string().optional()` 第 552 行（skipped 字段）未加长度约束，此为刻意决策（非凭证分录）。若将来该字段也有金蝶长度要求，可单独补加。
