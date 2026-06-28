# Spec:文件库页打磨(6 项,真数据测出)

## 背景
文件库页(`app/files/page.tsx`)用真数据测出 6 个问题。除第 1 项动一处 Tauri 能力配置外,**只改文件库页**,别碰别的页面(除非第 2 项需要后端加 kept 过滤,那只动 `app/api/files-library/route.ts` 查询)。沿用 Folio token + 镜像知识库页风格,功能不变,只改展示 + 修 bug。

## 修复项

### 1. 导出失败(Tauri 权限)
- 报错:`dialog.save not allowed ... Permissions: dialog:allow-save`。`src-tauri/capabilities/default.json` 有 `dialog:allow-open` 但**缺 `dialog:allow-save`**。
- 修:加 `dialog:allow-save`;并确认「在系统中显示」(reveal)所需权限齐全(`shell:allow-open` 已有;若 reveal 走 opener 插件的 reveal-item-in-dir,补对应权限)。JSON 合法、不破既有。
- 注:此项**浏览器/dev 验不了**(Tauri 权限仅打包 app 生效),靠用户在真 app 验。

### 2. 点「保留」分类统计数字不变
- 根因:`kindCounts` 按 `f.kind` 计数;「已保留」chip 数的是 `kind==="library"`,但点保留只把 `kept` 置 true(kind 仍 upload/generated)→「已保留」数不动。
- 修:「已保留」的**计数与筛选都按 `kept===true`**(不是 `kind==="library"`)。点保留后已 `fetchFiles()` 刷新,数字随之更新。若后端不支持按 kept 筛,在 `/api/files-library` 加 kept 过滤。

### 3. 上传/生成 用卡片颜色区分 + 分类 chip 上色
- 现仅用小徽标区分 kind。改为:**卡片按 kind 上色**(左侧色条或整卡淡色底,沿用 `KIND_BADGE_CLS` 已有色系:upload=蓝 / generated=紫 / knowledge=绿 / library=琥珀);**顶部筛选 chips 也各上对应色**(选中=实色,未选=淡色)。克制、Folio 风。

### 4. 搜索框出现两个 ×
- `<input type="search">` 带浏览器**原生 ×** + 代码自带的清除 × → 两个。修:**改 `type="text"`** 去掉原生那个,保留自定义 ×。

### 5. 「加入知识库」按钮去文字
- 预览头那个「加入知识库」是图标 + 文字。改成**纯图标 + hover tooltip「加入知识库」**(和其它行操作一致,用 title / Tooltip)。

### 6. 列表 → 卡片(按对话分组)
- 现是横线列表,看着累。改成**卡片网格**:
  - **按对话(`conversationId`)分组**:同一会话的文件一组;`conversationId` 为 null 的(知识/已保留)按 `source` 分组。
  - 每组内卡片网格 **一排 3 个**(参考知识库页 `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3`);组满 3 个**换行**——对话 a 有 4 个文件 = 3+1,**下一个对话另起一组/行**(不和上一组拼排)。
  - 每组上方一个轻量分组标题(对话标题 / 类目),让"按对话分组"看得出来。
  - 每张卡片:文件图标 + 名称 + kind 色 + 大小/时间 +(可选)摘要;**操作按钮排在卡片内下方一行**(预览 / 加入知识库[仅 upload·generated] / 在系统显示 / 导出 / 保留 / 删除,**纯图标 + tooltip**)。
  - 参考知识库页的 `DocCard`(`app/knowledge/doc-card.tsx` 若有)风格保持统一。

## 约束 / 红线
- 只动 `app/files/page.tsx` + `src-tauri/capabilities/default.json`(+ 必要时 `app/api/files-library/route.ts` 的 kept 过滤)。别碰别的页面/组件。
- 沿用 Folio token,镜像知识库卡片风格;功能(预览/reveal/导出/删除/保留/加入知识库/筛选/搜索)全保留。
- 红线不变(导出仅存本机、promote 落审计等已有逻辑别动)。

## 验收(AC)
- **AC1** `default.json` 含 `dialog:allow-save`(+ reveal 所需);JSON 合法、既有不破。
- **AC2** 点「保留」后「已保留」计数 +1(按 `kept` 计,筛选/计数一致)。
- **AC3** 卡片按 kind 上色 + 分类 chips 各上对应色,选中态清晰。
- **AC4** 搜索框只剩**一个** ×。
- **AC5** 「加入知识库」纯图标 + hover tooltip,无常驻文字。
- **AC6** 文件以**卡片**呈现,**按对话分组、一排 3 个、组间换行**;操作按钮在卡片下方、纯图标 + tooltip。
- **AC7** 回归:筛选/搜索/预览/reveal/导出/删除/保留/加入知识库 功能不变;`npm run typecheck` / `npm test` / `npm run lint` 全绿(末尾 pptx/secret-store 既有告警忽略,`# fail` 0)。

## 测试
- 主要是 UI——靠 typecheck + 既有测试不破。若第 2 项后端加 kept 过滤,补/改对应后端测试(隔离 DB)。
- 卡片/分组/颜色/统计的视觉,**集成时我会 seed 真文件截图核**,你不用做截图。

## 文件
- `app/files/page.tsx`(2/3/4/5/6)
- `src-tauri/capabilities/default.json`(1)
- 可能 `app/api/files-library/route.ts`(2 的 kept 过滤)

## 不做
- 改别的页面;Excel 编辑;Windows 存储;改 promote/迁库等已有逻辑。
