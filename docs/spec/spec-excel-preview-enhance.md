# Spec:Excel 预览增强(公式栏 / 数字格式 / 紧凑密度+右对齐 / 文件边框加粗)

## 背景与目标
现状:`app/shared/file-preview-page.tsx` 用 ExcelJS 把 .xlsx 渲成只读 HTML 表格(已有:多 sheet 标签、冻结表头/行列号、网格线、合并单元格、列宽、单元格底色)。但**看不懂表怎么算的、数字没格式、太松**:网格里显示公式的计算结果(非公式)、`numFmt`(货币/千分位/百分比)全丢、padding 大且自动换行、数字未右对齐、文件自身的边框/加粗未渲染。

把它做成**"能扫、能信、看得懂怎么算"的只读查看器**(不是 Excel 皮肤克隆、不是编辑器)。四项改动:

1. **公式栏(fx bar)**:点任意单元格 → 网格上方一条栏显示该格地址(name box,如 `B5`)+ 公式或值(`=SUM(B1:B4)` 或原值)。
2. **数字格式**:按 ExcelJS `cell.numFmt` 渲染货币 ¥ / 千分位 / 百分比 / 小数位 / 负数(按格式红字或括号);日期已处理,保留。
3. **紧凑密度 + 数字右对齐**:收紧行高(接近电子表格密度),默认单行(超长省略号 + 公式栏/hover 看全),数字单元格右对齐 + `font-variant-numeric: tabular-nums`。
4. **保留文件边框/加粗**:从 ExcelJS 取 `cell.border` / `cell.font.bold`(及对齐 `cell.alignment.horizontal`、字体色)渲染——财务用边框/粗体标小计/合计/表头,渲出来才与原文件一致、可信。

## 硬约束
- **只读**:不加编辑能力(编辑诉求走 agent 的 xlsx skill)。保留现有"选区发给 agent"(`onSelectionChange`)与多 sheet / 合并 / 冻结表头。
- **沿用 Folio 主题 token**(`--doc-*`):**不要**引入冷灰/微软绿 Excel chrome——在暖纸面里把密度和保真做对。
- **红线 7**:纯本地渲染、零网络(现状即是,别引入外发)。
- **最小改动**:只动 Excel 预览相关(`file-preview-page.tsx` 解析+渲染、`preview.css`、可加一个 numfmt 工具),别动 docx/pdf/图片预览,别动别的页面。

## 设计要点
- **数字格式**:优先用轻量库格式化 `numFmt`(若 `package.json` 已有 `ssf`/`numfmt`/SheetJS 就复用;没有则**手写覆盖常见财务格式**:`#,##0`、`#,##0.00`、`¥#,##0.00`、`0%`、`0.0%`、`#,##0;[Red]-#,##0`、`@`、日期格式;识别不了的回落原值字符串,**别报错、别瞎编**)。把格式化集中成一个纯函数 `formatNumber(value, numFmt)` 便于测。
- **公式提取**:已有 `isFormulaValue`;扩展每个 cell 的数据结构带上 `formula?:string`(`=...`)与 `display`(格式化后的展示值);网格显示 `display`,公式栏显示选中格的 `formula ?? display`。
- **对齐/类型**:数字(`typeof result === 'number'` 或 numFmt 是数字格式)右对齐;有 `cell.alignment.horizontal` 时以文件为准。
- **边框/加粗**:扩展 `extractCellStyle` 返回 `{ backgroundColor?, border?, bold?, align?, color? }`,渲成内联样式(边框用 ExcelJS border style → 1px solid 对应色;粗体 `font-weight:600`)。
- **密度**:cell padding 收到约 `2px 8px`、行高紧凑;`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`;`title={fullValue}` 便于 hover 看全。冻结表头/网格线保留。
- 性能:虚拟滚动**不在本期**(大表后置),但单行+收紧本身已缓解。

## 验收(AC)
- **AC1** 公式栏:点含公式的单元格 → 栏显示地址 + `=公式`;点普通格 → 显示地址 + 值。
- **AC2** 数字格式:货币/千分位/百分比/小数位/负数按 numFmt 正确格式化;识别不了的格式回落原值不崩。
- **AC3** 密度+对齐:行明显更紧凑、默认单行省略号;数字右对齐 + tabular-nums;文本左对齐(或随文件 alignment)。
- **AC4** 边框/加粗:文件里有边框/粗体的单元格(如合计行、表头)在预览里渲出边框与粗体。
- **AC5** 回归:多 sheet 切换、合并单元格、冻结表头、选区发 agent 仍正常;docx/pdf/图片预览不受影响。
- **AC6** 主题:全程用 `--doc-*` token,无冷灰/绿硬编码色。

## 测试
- 纯函数单测(`tests/` 下,wire 进 `tests/all.test.ts`,或扩 `file-preview.test.ts`):`formatNumber(numFmt)` 各常见格式、公式提取(`=...`)、边框/加粗/对齐 style 提取、数字右对齐判定。无需浏览器。
- `npm run typecheck` / `npm test` / `npm run lint` 全绿(末尾 pptx/secret-store 两条既有告警忽略,`# fail` 为 0)。

## 截图自验(给我看样式用)
- 加一个**fixture xlsx**(放 `tests/fixtures/` 或 `e2e/fixtures/`),内容覆盖四项:几个公式(`=SUM`/`=A1*B1`)、货币/千分位/百分比/小数格式、一行**加粗+上边框的合计**、一个表头加粗、若干文本+数字混排、至少一个合并单元格。
- 提供一个**可运行的截图方式**渲染增强后的 Excel 预览(注意:预览页正常靠 Tauri 文件对话框取路径,浏览器/Playwright 没有——需要一个绕过:test-only 路由/URL 参数加载 fixture,或最小 harness 页直接把 fixture 的 ArrayBuffer 喂给 Excel 网格组件;你选最干净的)。Playwright spec 截图存到固定路径(如 `test-results/excel-preview.png`)。
- **能在你环境跑就跑**,把截图路径与跑法写进报告;跑不动就把"我这边一条命令出图"的确切命令写清楚。

## 文件(预计)
- `app/shared/file-preview-page.tsx`(解析:formula/display/style;渲染:公式栏 + 单元格对齐/边框/加粗)
- `app/styles/preview.css`(公式栏、密度、右对齐、边框、加粗)
- 可加 `lib/preview/numfmt.ts`(numFmt 格式化纯函数)
- 测试 + fixture xlsx + 截图 spec

## 不做
- 编辑 / 写回 xlsx / 公式重算;虚拟滚动;`.xls` 旧格式;Excel chrome 皮肤克隆。
