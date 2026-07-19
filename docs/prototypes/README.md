# 页面原型 Prototypes

改 UI 前先在这里画 / 更新原型 → 看 → 满意 → 再动 `app/` 真代码。原型是高保真线框，复用真实设计 token，纯 HTML+CSS、零构建，双击 `index.html` 即开。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 原型索引，列出所有页面 |
| `cockpit.html` | 总览页原型（首个样板） |
| `_prototype.css` | **共享样式**：镜像 `app/styles/tokens.css` + `globals.css` 的 token，加壳层/卡片/tone 骨架。改一处，全部原型跟着变 |
| `_prototype.js` | 主题切换 + 右下角运行时**调节面板** |

## 可调整性

- **全局观感**：改 `_prototype.css` 顶部的 token（颜色 / 圆角 / 间距 / 字号），所有页同步。
- **当场试参数**：任意原型右下角 ⚙ 面板可实时拖动圆角 / 页边距 / 卡片间距 / 主色相、切深浅色。满意后把数值告诉我，我落到真实 token。
- **单页结构**：每页是独立 HTML，改一页不影响其它页。
- **保真同步**：真实 token 变了，同步 `_prototype.css` 顶部对应值即可。

## 约定

- 复用 class：`.card` / `.surface` / `.tone-pill` / `.tone-dot` / `.toned` / `.btn*` / 排版 `.t-title|.t-body|.t-meta|.t-small|.t-figure`。
- tone 用法：`style="--tone:var(--tone-tax)"` 挂在 `.tone-pill|.tone-dot|.toned` 上。
- 这套 token 是「原型专用镜像」，不参与真实构建；真实 UI 以 `app/` 为准。
