# Spec: 知识库搜索结果展示优化

> 版本 v1.0 / 2026-06-08
> 目标：左侧搜索结果全部展示（滚动），右侧文本预览支持命中行高亮与 ↑↓ 导航。不影响共用组件和原文件预览。

---

## 1. 背景

当前 `app/knowledge/page.tsx` 搜索 tab 有两个问题：

1. **左侧匹配片段只展示前 2 条** — `slice(0, 2)` 硬编码，命中多时看不到完整信息
2. **右侧文本预览无导航** — 命中行高亮一次后无法跳转到其他命中位置

---

## 2. 左侧：全部匹配 + 滚动

### 2.1 现状

```tsx
// page.tsx 搜索结果卡片内
{f.matches.slice(0, 2).map((m, i) => (...))}
```

### 2.2 目标

每个文件卡片的匹配片段全量展示。卡片设 `max-height: 300px; overflow-y: auto`，超出时纵向滚动。`hitCount > 展示数` 时底部提示「共 N 条匹配」。

### 2.3 实现

- 去掉 `slice(0, 2)`，改为 `f.matches.map(...)`
- 卡片 body 包裹层（匹配片段容器）加 inline style: `maxHeight: 300, overflowY: "auto"`
- 鼠标点击某条匹配片段时设置当前行号 → loadSearchPreview

### 2.4 验收

- [ ] 上传含 10+ 处关键词的 .md，搜索后同文件卡片内可滚动查看全部匹配
- [ ] 旧数据兼容：`hitCount` 来自 rg 聚合，`matches` 最多 10 条（rg-search.ts `MATCH_LIMIT_PER_FILE=10`），展示全部 10 条
- [ ] 无匹配时不报错，保持空态文案

---

## 3. 右侧：命中行高亮 + ↑↓ 导航

### 3.1 现状

文本镜像按行 `<pre>` 渲染，`selectedLineNo` 行加 `.target` class（背景色 + 左侧色条），只能跳一次。

### 3.2 目标

预览区展示文本镜像，所有命中行标亮，当前焦点行高亮，↑↓ 按钮切换焦点行。

### 3.3 数据来源

当前选中文件 `SearchFile` 中的 `matches: SearchMatch[]` 提供了所有命中行的 `lineNo`。从 `results.files` 中找到 `docId` 匹配的文件即可取到。

关键状态：
```ts
// 当前在预览的文件 docId
const [previewDocId, setPreviewDocId] = useState<number | null>(null);
// 命中行数组（排序去重）
const [hitLines, setHitLines] = useState<number[]>([]);
// 当前命中索引（指向 hitLines）
const [hitIndex, setHitIndex] = useState<number>(-1);
```

### 3.4 交互

| 操作 | 行为 |
|------|------|
| 点击左侧匹配片段 | `previewDocId` → 当前文件 docId，`hitIndex` → 对应匹配的索引，`loadSearchPreview(docId)`，滚动到目标行 |
| 点击 ↓ | `hitIndex = (hitIndex + 1) % hitLines.length`，scrollIntoView 到新行 |
| 点击 ↑ | `hitIndex = (hitIndex - 1 + hitLines.length) % hitLines.length`，scrollIntoView 到新行 |
| 键盘 ↑↓ | 同上（监听 keydown） |
| 点击另一文件 | 重置 `hitLines` 和 `hitIndex` |

### 3.5 UI 结构

```
[预览 bar] 文件名 · X/N 个匹配  [↑] [↓]
[预览内容] 每行按行号渲染
  L1  ...  ← 命中行 .hit
  L2  ...  
  L3  ...  ← 当前焦点 .hit.active（比普通命中行更突出）
  ...
```

- **导航 bar**：sticky top，33px 高，文件名 + "第 2/8 个匹配" + 两个按钮
- **命中行 `.hit`**：`background: var(--accent-soft)`，半透明
- **焦点行 `.hit.active`**：额外 `box-shadow: inset 3px 0 0 var(--accent)` 左侧色条，`background` 更深
- **跳转**：`scrollIntoView({ block: "center" })`

### 3.6 CSS

不在全局 CSS 文件里加 class，用 `<style jsx>` 或现有 CSS 变量。如果现有 `preview-line` / `target` 样式在全局 CSS 里，沿用并扩展。

检查现有样式（`app/globals.css` 或 `app/knowledge/knowledge.css`）：
```css
.preview-line.target { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
```
复用 `.target` 作为焦点行样式，新增 `.hit` 作为普通命中行样式。

### 3.7 验收

- [ ] 搜索关键词，点击左侧匹配片段，右侧跳转到对应行，该行高亮
- [ ] 点击 ↓ 跳到下一个命中行（循环）；点击 ↑ 跳到上一个命中行（循环）
- [ ] 命中行全部有 `.hit` 背景色，当前焦点行有 `.target` 色条
- [ ] 切换到另一个搜索结果文件时，导航重置
- [ ] 切换回浏览 tab 再切回来，状态不残留

---

## 4. 不改动的边界

| 组件/功能 | 是否改动 | 说明 |
|-----------|---------|------|
| `FilePreviewPage`（共用） | 不动 | 浏览 tab 的预览原封不动 |
| `app/chat/chat-preview-sidebar.tsx` | 不动 | 对话中文件预览不碰 |
| `lib/knowledge/rg-search.ts` | 不动 | `MATCH_LIMIT_PER_FILE=10` 保持不变 |
| `/api/knowledge/search` | 不动 | 响应结构不变 |
| `/api/knowledge/documents/[id]/content` | 不动 | 文本镜像 API 不变 |
| `/api/knowledge/documents/[id]/file` | 不动 | 原文件服务不变 |
| `app/shared/file-preview-page.tsx` | 不动 | 共用预览组件不碰 |
| 浏览 tab 的文档列表和上传 | 不动 | 只有搜索 tab 的渲染逻辑改动 |

---

## 5. CSS 检查清单

搜索 tab 预览区的样式用独立 class，不与浏览 tab 的 `.knowledge-preview` 冲突：

- `.search-preview-bar` — 顶部导航 bar（sticky）
- `.search-preview-bar .nav-btn` — ↑↓ 按钮
- `preview-line.hit` — 命中行标记
- `preview-line.target` — 当前焦点行（复用已有样式）

全局 CSS 里 `.preview-line` / `.target` 若已定义，检查是否影响浏览 tab 的 `FilePreviewPage`（后者用的是另一套 DOM 结构，不应冲突）。

---

## 6. 执行步骤

1. **检查现有 CSS** — 确认 `.preview-line`、`.target` 定义位置和影响范围
2. **改左侧渲染** — 去掉 `slice(0,2)`，加滚动容器，加"共 N 条匹配"提示
3. **加 hitLines/hitIndex 状态** — `useState` 管理命中行数组和当前索引
4. **改右侧预览** — 加导航 bar、命中行 `.hit` class、↑↓ 逻辑
5. **改点击联动** — 左侧匹配片段点击时正确设置 hitIndex 并跳转
6. **tsc 编译通过** — `npx tsc --noEmit`
7. **视觉验收** — `npm run dev`，浏览器里搜索含多命中词条的文档，验证滚动、高亮、导航、循环
8. **边界验证** — 空结果、rg 未安装、切换 tab、切文件、大文件 (>1MB)
9. **回归检查** — 浏览 tab 文档列表、预览、删除、上传功能正常；对话页文件预览正常

---

## 7. 测试要点

- [ ] 左边搜索结果全部片段可见，超过容器高度可滚动
- [ ] 右边所有命中行高亮（`.hit`），当前焦点行突出（`.target`）
- [ ] ↑↓ 导航循环正确（首→尾、尾→首）
- [ ] 键盘 ↑↓ 也可导航
- [ ] 点击另一文件的匹配片段，导航和焦点重置
- [ ] 切换「浏览」tab 后切回「搜索」，状态干净
- [ ] `FilePreviewPage` 在浏览 tab 正常渲染 PDF/docx/xlsx 预览
- [ ] 对话页附件预览（`chat-preview-sidebar`）不受影响
- [ ] `npm test` 全部通过

---

完。
