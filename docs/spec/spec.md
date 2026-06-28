# 财务 Agent 第一版 Spec

## 目标

建设一个给财务人员使用的单人工作台，支持报销处理、薪税计算、财务分析和金蝶集成预留。第一版强调可用流程、确定性计算、表格产出和审计留痕。

默认持久化采用 SQLite，以便未来同时支持 Windows 和 macOS 本地运行。

## 非目标

- 不做员工自助入口。
- 不做多角色权限和审批流。
- 不直接写入金蝶正式凭证。
- 不让大模型直接决定最终税额、工资或入账结果。

## 功能一：报销处理

输入：发票明细、报销表、CSV/Excel/PDF 解析结果。

输出：标准报销登记表、异常清单、财务确认状态。

校验规则：

- 报销日期是否缺失或晚于当前日期。
- 发票号是否重复。
- 金额是否小于等于 0。
- 单笔金额是否超过配置上限。
- 类目是否缺失。

## 功能二：薪税计算

输入：工资模板、税率配置版本、社保公积金扣除、专项扣除。

输出：应发工资、应纳税所得额、应缴个税、实发工资。

第一版使用月度简化计算模型，后续替换为累计预扣预缴完整模型。

## 功能三：财务分析

输入：现有表格或 Agent 生成的标准表。

输出：部门费用汇总、费用类别汇总、异常费用、趋势分析表。

## 功能四：金蝶预留

第一版提供 `AccountingAdapter` 接口和导出草稿能力，不调用真实金蝶 API。

## 功能五：Claude Agent 配置

配置中心支持维护 Claude Agent SDK 所需配置：

- API URL。
- API Key。

API Key 只保存在本机配置文件中，不通过查询接口返回明文。未配置 API Key 时，系统回退到本地 mock Agent。

## 本地数据

第一版本地数据库使用 SQLite，默认文件位于系统应用数据目录：

```text
macOS: ~/Library/Application Support/finance-agent/finance-agent.db
Windows: %APPDATA%\finance-agent\finance-agent.db
Linux: ${XDG_DATA_HOME:-~/.local/share}/finance-agent/finance-agent.db
```

用途：

- 任务和审计日志。
- 技能配置快照。
- 后续报销批次、薪税计算版本和驾驶舱指标缓存。

当前 skill 仍保留文件驱动，但可编辑副本写入应用数据目录；仓库内 `skills/` 只作为初始种子资源。

## 交互设计

页面采用三栏工作台：

- 左侧：任务导航与配置状态。
- 中间：当前任务的数据表、上传入口、结果预览。
- 右侧：独立文件预览页，支持对话文件和本地文件多格式查看。

## 功能六：文件面板与多格式预览

### 面板标签

- 对话框右上角新增 `面板` 标签，与右侧栏展开/收起按钮并排。
- 面板内承载当前对话的文件卡片，替代原右侧栏文件列表。
- 按 `输出 / 来源` 分组展示文件。
- 当 Agent 生成新输出文件时，面板自动展开一次，便于用户立即发现结果。
- 用户可手动点击 `面板` 标签关闭或再次展开。
- 点击消息区、面板中的文件后，右侧预览页自动切换到对应文件。

### 右侧预览页

- 右侧栏不再展示文件列表，改为独立文件预览页组件。
- 该组件同时提供一个单独页面入口，便于后续脱离聊天页独立使用。
- 预览页支持通过 Tauri 系统文件选择器打开本地文件，也支持预览当前对话的持久化附件。

### 支持格式

- Markdown / TXT：
  - 本地文件：调用 `@tauri-apps/plugin-fs` 的 `readTextFile()` 读取字符串。
  - 对话文件：通过 `/api/files/:conversationId/...` 获取文本内容。
  - Markdown 使用 `react-markdown + rehype-highlight` 渲染。
  - TXT 使用 `<pre>` 展示。
- 图片（png / jpg / jpeg / gif）：
  - 本地文件：`readFile()` 读取 `Uint8Array`，生成 `Blob URL` 后用 `<img>` 展示。
  - 对话文件：直接使用后端文件流 URL。
  - 展示尺寸、格式、大小。
- Excel（xlsx / xls）：
  - 本地文件和对话文件都统一转成 `Uint8Array`。
  - 使用 `XLSX.read(bytes, { type: "array", cellStyles: true })` 解析。
  - 自绘 HTML 表格渲染，支持多 sheet tab 切换。
  - 提取 `cell.s.fgColor` / `cell.s.bgColor` 转为 inline CSS `backgroundColor`，浅色/深色模式下均可见。
  - 合并单元格通过 `!merges` 处理 colSpan/rowSpan。
  - 公式栏显示当前选中单元格的公式（`cell.f`）。
- Word（docx）：
  - 使用 `docx-preview` 的 `renderAsync(bytes, container)` 渲染。
  - 渲染为语义 HTML（`<p>` + `<table>`），保留字体、颜色、表格、图片、页眉页脚。
  - 通过 `next/dynamic` 延迟加载，避免 SSR 报错。
  - 知识库文本提取（`lib/knowledge/parsers/index.ts`）继续使用 `mammoth.extractRawText()` 提取纯文本，不引入 docx-preview 到 Node 端。
- PDF：
  - 使用 `react-pdf` 渲染页码预览。
  - 支持页码切换和总页数展示。

### Tauri 权限与依赖

- `@tauri-apps/plugin-dialog`：系统文件选择器。
- `@tauri-apps/plugin-fs`：读取本地文本和二进制文件。
- `@tauri-apps/plugin-shell`：保留系统打开能力，并在 capability 中允许 `soffice` 命令，供后续 PPT 转换扩展使用。
- `tauri.conf.json` 中启用 `fs` scope：`["**"]`。

## 验证目标

- 聊天页右上角存在 `面板` 标签，且与右侧栏展开按钮并排。
- 原右侧文件卡片迁移到面板内，右侧栏默认显示预览页空状态。
- 产生新的输出文件时，面板会自动展开。
- 点击消息区文件、面板文件，可将右侧预览页切换到对应文件。
- 预览页可通过系统文件选择器打开 `md/txt/png/jpg/jpeg/gif/xlsx/xls/docx/pdf`。
- Markdown 代码块高亮、TXT 纯文本、图片信息、Excel 多 sheet、DOCX HTML、PDF 页码预览全部可渲染。
- Tauri 配置已包含 `dialog`、`fs`、`shell soffice` 所需权限。

## 验收标准

- 能打开前端首页看到财务工作台。
- 能通过 API 获取报销、薪税、分析三个演示任务结果。
- 能通过 API 分别调用报销校验、薪税计算、费用汇总。
- SQLite 初始化模块可创建本地审计表和技能快照表。
- 配置中心可保存 Claude Agent API URL/API Key。
- Python Worker 能完成 CSV 示例解析和分析。
- 文档包含架构图和第一版 spec。
- 金蝶和真实 Claude SDK 接入点有接口和中文预留注释。
