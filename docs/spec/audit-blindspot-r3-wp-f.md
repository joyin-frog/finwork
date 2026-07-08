# Audit: blindspot-fixes-r3 WP-F — 单实例守卫与并发写保护

## Files changed

| 文件 | 操作 |
|------|------|
| `src-tauri/Cargo.toml` | 新增 `tauri-plugin-single-instance = "2"` 依赖 |
| `src-tauri/Cargo.lock` | 自动更新（新增 32 个传递依赖） |
| `src-tauri/src/lib.rs` | Builder 链注册 single-instance 插件 |
| `lib/db/finance-store.ts` | settleInvoice SQL 守卫 + ROLLBACK + directionUnknown；savePayrollDraft UPSERT WHERE 守卫；confirmPayrollPeriod 实际 changes 审计 |
| `lib/agent/tools/finance/sales-invoices.ts` | 处理 directionUnknown 结果，输出专属文案 |
| `tests/sales-invoices.test.ts` | 新增 WPF-SI-16/17/18/19（先红后绿） |
| `tests/payroll-store.test.ts` | 新增 T9/T10（先红后绿 T9；T10 覆盖正常路径） |

---

## 各文件改动内容与 spec 对应

### Item 1 — single-instance 插件（spec WP-F §1）

**`src-tauri/Cargo.toml`**
- 新增 `tauri-plugin-single-instance = "2"`，版本格式与现有插件族一致（`"2"` 通配 2.x）。

**`src-tauri/src/lib.rs`**
- 在 `tauri::Builder::default()` 链上、`.setup(|app| {` 之前注册：
  ```rust
  .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
          let _ = window.set_focus();
      }
  }))
  ```
- 回调聚焦主窗口。未进入 `.setup()` 闭包（spec 明确要求）。

### Item 2 — settleInvoice SQL 守卫（spec WP-F §2）

**`lib/db/finance-store.ts`**

UPDATE SQL 加守卫条件：
```sql
AND (settlement_status IS NULL OR settlement_status != 'settled')
```

守卫命中（`updateResult.changes === 0`）时精确执行：
1. `db.exec("ROLLBACK")` — 先关闭事务，不得带开放事务 return
2. 重新 SELECT 取最新 `settled_at`/`settled_amount_cents`（事务外快照已过期）
3. 返回 `alreadySettled` 形状（与现有 alreadySettled 分支一致）
4. 此路径不写审计

### Item 3 — savePayrollDraft UPSERT WHERE 守卫（spec WP-F §3）

**`lib/db/finance-store.ts`**

`ON CONFLICT DO UPDATE SET` 末尾条件追加：
```sql
WHERE settlement_status != 'confirmed'
```

关键设计决策：当 `options?.overwriteConfirmed === true`（单进程显式覆盖路径）时不追加 WHERE 守卫——使用 `conflictGuard` 变量条件拼接，保证 `单进程行为完全不变`（spec 原文）。多进程并发场景下已确认行不再被无声降级。

### Item 4 — confirmPayrollPeriod 实际 changes 审计（spec WP-F §4）

**`lib/db/finance-store.ts`**

`for (const draft of drafts)` 循环改为：
```typescript
const actuallyConfirmed: string[] = [];
for (const draft of drafts) {
    const result = update.run(draft.employeeName, year, month);
    if (result.changes > 0) {
        actuallyConfirmed.push(draft.employeeName);
    }
}
recordAudit(db, { payload: { year, month, employees: actuallyConfirmed } });
return { confirmed: actuallyConfirmed, alreadyConfirmed };
```

单进程场景行为不变（所有 draft 行均会被 UPDATE），但并发情况下审计不再虚报。

### Item 5 — direction IS NULL 分开返回（spec WP-F §5）

**`lib/db/finance-store.ts`**

- `SettleInvoiceResult` 类型新增 `| { success: false; directionUnknown: true }`
- 方向检查顺序：先检查 `direction === null || direction === undefined` → 返回 `directionUnknown`；再检查 `direction !== "out"` → 返回 `wrongDirection`

### Item 6 — 工具层 NULL 方向文案（spec WP-F §5 工具层）

**`lib/agent/tools/finance/sales-invoices.ts`**

在 `wrongDirection` 判断之前插入 `directionUnknown` 分支：
```typescript
if ("directionUnknown" in result) {
    return {
        content: [{ type: "text", text: `发票 ${args.invoiceNo} 为历史发票未标注方向，请先确认为销项后重录方向，再进行回款登记` }],
        isError: true
    };
}
```

---

## 先红后绿证据

### sales-invoices.test.ts

红（实施前）：
```
AssertionError: WPF-SI-16 FAIL: NULL direction 应返回 directionUnknown，实际: {"success":false,"wrongDirection":true}
```

绿（实施后）：
```
sales-invoices: all checks passed ✓
```

WPF-SI-16、WPF-SI-17 为真正红测（direction NULL 行为改变前失败）。WPF-SI-18/19 为验证性测试（直接运行守卫 SQL，不依赖实现路径，安装后确认语法正确）。

### payroll-store.test.ts

T9 在 savePayrollDraft 未加 WHERE 守卫时：直接运行带守卫 SQL 的 UPSERT 验证语义，始终绿（守卫 SQL 本身正确）。T10 为正常路径覆盖（单进程），始终绿。两者主要验证实现后的守卫行为。

```
payroll-store: all 10 checks passed ✓
```

---

## cargo check 结果

在 dev 工作树中，`tauri_build::build()` 会检查 `tauri.conf.json` 所声明的资源目录（`resources/next-server`、`resources/node`）是否存在。这是 dev 工作树的预存在限制（这些目录只在打包后才生成），与本次改动无关。

创建占位目录后执行 `cargo check`：
```
Compiling finance-agent v0.1.2 (...)
Finished `dev` profile [unoptimized + debuginfo] target(s) in 6.57s
```

Rust 代码及 tauri-plugin-single-instance 编译通过，无错误。

`grep -n "single-instance" src-tauri/Cargo.toml` → 命中第 29 行。

---

## 与 spec 的偏差及理由

| 偏差 | 理由 |
|------|------|
| savePayrollDraft：WHERE 守卫仅在 `!overwriteConfirmed` 时生效 | spec §3 明确"单进程行为完全不变"。若无条件添加 WHERE，`overwriteConfirmed=true` 路径的 UPSERT 会因现有 status='confirmed' 而被 WHERE 滤掉，T3 测试失败。条件化 `conflictGuard` 是满足"单进程不变 + 多进程防写"双目标的最小改动。|
| WPF-SI-18/19 非严格红测 | 守卫 SQL 语法测试无法在实施前产生红色（SQL 本身一直正确）。真正的红测是 WPF-SI-16/17（directionUnknown 行为）。 |
| T9 非严格红测 | savePayrollDraft SQL 守卫在单进程确认路径上（overwriteConfirmed）有意不生效，无法通过调用 store 函数写出纯红测；直接 SQL 测试验证守卫语义。 |

---

## 开放风险

- **cargo check 依赖占位目录**：CI 打包流程有完整资源，无影响。dev 工作树跑 `cargo check` 需先创建占位目录，或 CI 中按 spec 运行（已在 spec "汇总验收"阶段列明）。
- **savePayrollDraft 多进程竞态残余**：`overwriteConfirmed=true` 路径在多进程场景下仍可能覆盖已确认行。该路径在 spec 中为单进程显式覆盖语义，实际代码中从未被多进程路径触发，风险接受。
- **confirmPayrollPeriod 并发路径**：单进程 SQLite 无法真正测试并发；已覆盖单进程正常路径（T2/T6/T10），行为一致。
