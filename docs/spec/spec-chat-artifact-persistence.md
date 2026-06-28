# 对话产物与过程展示 Spec

> 范围：`/chat/recent?id=14` 对话页中的思考过程、文件链接、同名文件处理、工具调用展示。不改变模型调用主流程，不引入新的后端服务。

## 1. 思考过程持久化

现状：流式 thinking 只通过 SSE 发送到前端状态，完成后没有写入 `chat_agent_events`，刷新或再次进入最近对话时消失。

目标：

- 运行中仍显示“思考中…”和增量内容。
- 完成后把完整 thinking 作为 `chat_agent_events` 的 `thinking/end` 事件写入数据库。
- 再次打开 `/chat/recent?id=14` 时，助手消息上方仍能看到可展开的思考过程。
- thinking 内容按模型原文保存；系统提示要求 agent 面向用户的解释和过程文本优先使用中文。

验收：

- 流式请求完成后，assistant message 对应 `chat_agent_events` 至少包含一条 `event_type='thinking'`。
- 重载最近对话时 `getPersistedTimeline(message)` 能恢复 thinking block。

## 2. `finance-file://` 链接渲染为文件标题

现状：当 markdown 中的 `finance-file://generate%2Fxxx.xlsx` 未匹配到前端文件列表时，会退化为普通链接文本。

目标：

- 所有 `finance-file://` 链接都渲染成高亮文件标题按钮。
- 按钮显示文件图标 + 文件名。
- 点击后直接进入右侧预览。
- 对普通文件名文本仍自动链接到已知文件。

验收：

- markdown 文本 `[都森2026-2030年预测分析.xlsx](finance-file://generate%2F...)` 渲染为 `.inline-file-link`。
- 即使 `files` 列表尚未匹配，仍能根据 href 的 storage path 构造预览选择。

## 3. 同目录文件名去重

现状：上传或生成同名文件时会覆盖同目录旧文件，或者覆盖后不被 `snapshotDirectory` 识别为新产物。

目标：

- 上传目录内同名文件自动改名，例如 `报告.xlsx`、`报告 2.xlsx`、`报告 3.xlsx`。
- 生成目录内同名文件也自动改名。
- `run_python` 通过隔离临时输出目录执行，再把产物移动到会话 `generate/` 目录并去重，避免覆盖旧产物。
- 内置生成 Excel/PPT 工具直接写入去重后的目标路径。

验收：

- 同一会话重复上传同名文件不会覆盖旧文件。
- 同一会话重复生成同名文件时，最近文件名称自动追加数字并登记到 `chat_attachments`。

## 4. 工具调用展示优化

现状：最近对话页仍使用旧 `tool-card` 展示，视觉上重、散、代码块过大。

目标：

- 当前 `/chat/recent` 使用 `ToolStepList` 的紧凑结构展示工具调用。
- 运行中和完成后都使用同一套工具调用结构。
- 输入/输出默认折叠，展开后展示有限高度代码块。

验收：

- `app/chat/chat-page.tsx` 的助手消息不再使用旧 `ToolCards`。
- 工具调用卡片使用 `.tool-step-list` / `.tool-step` 样式。

