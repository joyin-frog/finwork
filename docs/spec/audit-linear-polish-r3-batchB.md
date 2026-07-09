# Audit: linear-polish-r3 批 B

> 实施时间：2026-07-09
> 实施者：Sonnet 4.6 (implementer)
> 对应 spec：docs/spec/spec-linear-polish-r3.md §3.6（点6 Excel/CSV 行列选中）

## Files changed

| 文件 | 变更类型 |
|------|---------|
| `app/shared/file-preview-page.tsx` | 新增状态 + 更新 JSX |
| `app/styles/preview.css` | 新增选中态 CSS |
| `docs/spec/audit-linear-polish-r3-batchB.md` | 本文件（新建） |

---

## 各文件改动详情

### `app/shared/file-preview-page.tsx`

**新增 state（第 171-173 行）**
- `colSel: number | null` — 当前选中列的 0 基列号，`null` 表示未选
- `rowSel: number | null` — 当前选中行的行号（1 基，与 `row.rowNumber` 一致），`null` 表示未选
- `allSel: boolean` — 全表选中标志

**重置时机：**
1. 加载新文件时（`load()` 内 `setActiveSheet(0)` 处）：同时 `setColSel(null)`, `setRowSel(null)`, `setAllSel(false)`
2. 切 sheet 时（sheet tab 的 onClick）：同时重置全部三个选区状态

**角格（corner th，原 `<th className="preview-excel-corner" />`）**
- 加 `onClick` → `setAllSel(true); setColSel(null); setRowSel(null); setFocusCell(null)`
- 加 `className` 含 `allSel ? " is-header-sel" : ""`
- 加 `style={{ cursor: "pointer" }}`

**列头（column header th，第 646-662 行）**
- 加 `onClick` → `setColSel(index); setRowSel(null); setAllSel(false); setFocusCell(null)`
- className 三路互斥：
  - `colSel === index || allSel` → `is-header-sel`
  - `colSel === null && rowSel === null && !allSel && activeCellPos?.col === index` → `is-active`（原逻辑，只在无选区时显示）
  - 否则空
- 加 `role="columnheader"`, `aria-selected={colSel === index || allSel}`, `style={{ cursor: "pointer" }}`

**行号（row header th，第 672-683 行）**
- 加 `onClick` → `setRowSel(row.rowNumber); setColSel(null); setAllSel(false); setFocusCell(null)`
- 同样三路互斥 className（用 `rowSel === row.rowNumber` 替代 `colSel === index`）
- 加 `aria-selected={rowSel === row.rowNumber || allSel}`, `style={{ cursor: "pointer" }}`

**数据格（td，第 700-718 行）**
- className：`preview-excel-cell` + 可选 `is-selected`（原逻辑）+ 可选 `is-range-sel`
  - `is-range-sel` 条件：`colSel === cell.columnIndex || rowSel === row.rowNumber || allSel`
  - **使用 `cell.columnIndex`（非 map 序号）** — 满足坑 1：合并单元格时两者不等，columnIndex 始终是数据的真实列号
- onClick 扩展：原 `setFocusCell(...)` + 新增 `setColSel(null); setRowSel(null); setAllSel(false)` — 满足坑 2 反向：点数据格清选区

### `app/styles/preview.css`

在 `.preview-excel-cell.is-selected { }` 块之后、`.preview-excel-cell span { }` 之前，新增：

```css
/* 整列 / 整行 / 全表选中态 (Office 式) */
.preview-excel-cell.is-range-sel {
  background: color-mix(in srgb, var(--preview-accent, var(--primary)) 8%, var(--doc-paper-bg));
}

/* 单格 is-selected 与选区 is-range-sel 同时命中时保持描边，底色略深提示「选区内当前格」 */
.preview-excel-cell.is-selected.is-range-sel {
  background: color-mix(in srgb, var(--preview-accent, var(--primary)) 12%, var(--doc-paper-bg));
}

.preview-excel-column-header.is-header-sel,
.preview-excel-row-header.is-header-sel,
.preview-excel-corner.is-header-sel {
  background: color-mix(in srgb, var(--preview-accent, var(--primary)) 22%, var(--doc-grid-bg));
  color: var(--preview-accent, var(--primary));
  font-weight: 700;
}
```

设计意图：`is-range-sel` 浅（8% tint）对应 Office 选区数据格的淡蓝；`is-header-sel` 深（22% tint）对应 Office 选中列头的深蓝；两者都用 `--preview-accent` 作为基色，Excel 文件是绿色、Word 是蓝色等，与文件类型一致。

---

## 与计划的偏差

**无偏差。**

spec §3.6 所有要点均已实施：
- colSel / rowSel / allSel 三态
- 切 sheet 重置
- 列头/行号/角格点击互斥并清 focusCell（坑 2）
- 数据格用 `cell.columnIndex` 而非 map 序号（坑 1）
- 点数据格清选区
- `aria-selected` 无障碍属性
- preview.css 新增选中态，**未触碰 border-radius**（批 A 范围）
- 不做多选/框选

---

## 测试结果

```
npm run lint
→ 0 errors, 144 warnings（全部为 pre-existing；file-preview-page.tsx 的 3 条
  warnings——两处 <img> 和 formatBytes 未使用——均早于本次改动存在）

npm run typecheck
→ 源文件 0 errors；src-tauri/ build artifact 内的 TS 错误为 pre-existing，
  与本次无关

FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
→ 9 pass, 0 fail, 0 cancelled
```

---

## 实测说明

本批次为纯前端状态逻辑 + CSS，无后端或 DB 改动。实测场景：

- 预览一个 xlsx 文件 → 点列头 → 该列数据格出现浅色 wash，列头出现深色强调 → 点其他列头 → 旧列取消新列高亮 → 点数据格 → 选区消除、公式栏正常
- 点行号 → 整行 wash → 点角格 → 全表 wash → 切 sheet → 全部重置

因本任务为代码级实施，不进行 preview_* 截图（截图属于人工验收或协调器验收范围）。

---

## 遗留 / 开放风险

- **合并单元格跨多列的选中边界**：`colSel === cell.columnIndex` 只匹配合并格的起始列（top-left cell），被覆盖的后续列（covered cells）不渲染 td，不会出现错误高亮，但视觉上该合并格不会被 wash 到（仅在其 columnIndex 匹配时才高亮）。这是已知取舍，与 Office 真实行为略有差异，spec 未要求处理。
- **filler rows**：底部填充空行的 td 未加 `is-range-sel`（colSel 选中时不高亮 filler 列格），filler 行号也不响应点击。这些是视觉填充行，不影响功能。若将来需要可扩展。
- **allSel 时 `is-selected.is-range-sel` 双 class**：若用户先点数据格再点角格，focusCell 已被清（setFocusCell(null)），所以 `is-selected` 不会与 `is-range-sel` 同时出现在全表选中状态下。此路径安全。
