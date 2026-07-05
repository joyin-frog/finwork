# 设置弹窗重构 Spec

> 版本 v1.0 / 2026-07-04
> 状态：已批准
> 依赖：无
> 架构事实：
> - 设置弹窗是 `/config` 路由页（非真正的 Dialog），视觉上用 `fixed inset-0` 遮罩模拟弹窗，见 `app/config/skill-center.tsx`。
> - 设置分类的单一数据源是 `app/config/tabs.ts` 的 `CONFIG_TABS`（`{key,label,icon}[]`），`skill-center.tsx` 据此渲染左侧菜单，`app/config/page.tsx` 据此校验 `?tab=` 深链。
> - 深链迁移用 `LEGACY_CONFIG_TAB_REDIRECTS`（旧 key → 现存 tab key），在 `page.tsx` 里 `redirect()`。
> - 各 tab 内容组件都是纯展示 + props 回调，状态和防抖保存逻辑集中在 `skill-center.tsx`（`saveClaudeSettings` / `scheduleClaudeSave`）。
> - 主导航侧栏在 `app/shared/app-nav.tsx`（`AppNav` 组件），当前激活态 `NavActive` 类型在该文件和 `app/shared/app-shell.tsx` 各定义一份（需同步改）。
> - 快捷键数据单一源是 `app/shared/shortcuts.ts` 的 `SHORTCUTS` 数组 + `formatShortcut()` + `useIsMac()`（`app/shared/use-is-mac.tsx`），本仓库快捷键是硬编码不可编辑的，只做展示。
> - `app/config/skill-catalog.tsx`（技能能力卡片）目前只在 settings 的「技能」tab 里被引用；`app/skills/page.tsx`（`SkillsManager`）已经是独立存在的技能文件编辑器路由 `/skills`。

## 0. 目标与非目标

**目标**：参考用户提供的 macOS 系统设置截图，重排设置弹窗：去掉顶部「设置」大标题、左上角改为常驻搜索框、消除左右分隔线被打断的视觉缝隙；把现有杂糅在「常规」里的内容拆分成 常规/外观/个性化/模型/键盘快捷键/关于 六个 tab；新增一个「键盘快捷键」设置子页面；把「技能」从设置弹窗搬到主导航「资料」下方，作为独立菜单项直接跳转到已有的 `/skills` 编辑器。

**非目标（本期不做，已知并接受）**：
- 不做快捷键的自定义改键/编辑/删除功能（截图里的铅笔/垃圾桶图标不做，因为 `SHORTCUTS` 目前是硬编码常量，没有可编辑的持久化层，属于另一个功能）。
- 不做设置项内容的搜索高亮/跳转定位，只做 tab 标签的子串过滤（简单可用，不做完整的全文搜索）。
- 不做视觉上的分组标题（如截图里的"通用/助手/数据"），六个 tab 就是一条平铺竖列，与用户原话"菜单依次有…"一致。
- 不迁移 `/skills` 编辑器页面本身的实现，只加一个导航入口指向它。

## 1. 成功标准

- [ ] 打开 `/config`：顶部不再显示"设置"文字标题；左侧栏顶部是一个可输入的搜索框（placeholder "搜索设置..."），输入内容能按标签子串过滤下方 tab 列表，清空恢复全部。
- [ ] 左侧栏与右侧内容区之间的竖线分隔（`border-r`）从弹窗最顶部延伸到最底部，不被顶部标题行打断；右侧内容区顶部不再有多余的大留白/独立分隔线。
- [ ] 左侧菜单只有 6 项，顺序为：常规、外观、个性化、模型、键盘快捷键、关于。
- [ ] 「常规」只剩：用户头像+用户名、助手名称+公司名称。
- [ ] 「外观」只有主题三选一（跟随系统/亮色/暗色），复用现成的 `AppearanceSettings`。
- [ ] 「个性化」包含：回复风格（原「常规」里的"展示工作过程"开关）、公司画像（`ProfileSettings`）、长期记忆（`MemorySettings`）。
- [ ] 「模型」包含：模型连接配置（原有 `ModelSettings` 内容）+ 用量（原 `UsageSettings`，从「关于」搬过来）。
- [ ] 「键盘快捷键」是新 tab，按 `SHORTCUTS` 数据源分组展示"命令 + 按键"两列，mac/windows 按键符号复用 `formatShortcut`/`useIsMac`。
- [ ] 「关于」只剩：版本信息、运行环境、数据与隐私（用量已移出）。
- [ ] 主导航「资料」下方新增「技能」菜单项，点击跳转 `/skills`；该项在 `/skills` 路径下高亮为当前激活项。
- [ ] 设置弹窗左侧菜单里不再有「技能」tab；旧深链 `/config?tab=skills` 重定向到 `/skills`；其余旧深链（`understanding`/`memory`/`profile`/`usage`）分别重定向到新 tab key。
- [ ] `npm run build`（或至少 `npx tsc --noEmit`）无新增类型错误；在浏览器里手动过一遍六个 tab + 搜索框 + 导航"技能"入口，截图确认。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/config/tabs.ts` | 修改 | `CONFIG_TABS` 改为 6 项（general/appearance/personalization/model/shortcuts/about），更新 `LEGACY_CONFIG_TAB_REDIRECTS` |
| `app/config/page.tsx` | 修改 | `tab=skills` 深链特判重定向到 `/skills`（不走 `LEGACY_CONFIG_TAB_REDIRECTS`，因为目标不是一个 settings tab） |
| `app/config/skill-center.tsx` | 修改 | 重排布局（去标题、搜索框、连续分隔线）；tab 内容改为渲染 General/Appearance/Personalization/Model/Shortcuts/About 六个组件；去掉 SkillCatalog 引用 |
| `app/config/general/general-settings.tsx` | 修改 | 删掉主题区块和"回复风格"区块，只保留用户 + 助手身份两个 `SettingsSection` |
| `app/config/personalization/personalization-settings.tsx` | 新增 | 组合 回复风格 SettingsSection + `ProfileSettings` + `MemorySettings`，props 接 `roleMode`/`onRoleModeChange`（从 general-settings 迁移过来的回复风格 UI 原样搬入） |
| `app/config/understanding/understanding-settings.tsx` | 删除 | 内容并入 `personalization-settings.tsx`，原文件删除 |
| `app/config/model/model-settings.tsx` | 修改 | 新增一个「用量」`SettingsSection`，渲染 `UsageSettings`（从 about-settings 搬来） |
| `app/config/about/about-settings.tsx` | 修改 | 删掉「用量」`SettingsSection` 及 `UsageSettings` 引用 |
| `app/config/shortcuts/shortcuts-settings.tsx` | 新增 | 按 `shortcuts.ts` 里 `SHORTCUTS`/`GROUPS`(仿 `global-shortcuts.tsx` 的分组) 渲染表格式列表，复用 `formatShortcut`+`useIsMac` |
| `app/config/skill-catalog.tsx` | 删除 | 不再被任何地方引用（原唯一引用点 skill-center.tsx 已移除） |
| `app/shared/app-nav.tsx` | 修改 | `NavActive` 类型加 `"skills"`；在"资料" `<Link>` 后新增"技能" `<Link href="/skills">` |
| `app/shared/app-shell.tsx` | 修改 | `active` 联合类型同步加 `"skills"`；`pathname.startsWith("/skills")` 分支设 `active="skills"` |

## 3. 实施步骤

1. **`tabs.ts`**：把 `CONFIG_TABS` 改成：
   ```ts
   { key: "general", label: "常规", icon: ConfigurationIcon },
   { key: "appearance", label: "外观", icon: PaintBoardIcon },
   { key: "personalization", label: "个性化", icon: BrainIcon },
   { key: "model", label: "模型", icon: BotIcon },
   { key: "shortcuts", label: "键盘快捷键", icon: KeyboardIcon },
   { key: "about", label: "关于", icon: InformationCircleIcon },
   ```
   `PaintBoardIcon`/`KeyboardIcon` 从 `@hugeicons/core-free-icons` 导入（已确认存在）。`LEGACY_CONFIG_TAB_REDIRECTS` 改为：
   ```ts
   export const LEGACY_CONFIG_TAB_REDIRECTS = {
     understanding: "personalization",
     memory: "personalization",
     profile: "personalization",
     usage: "model",
   } as const satisfies Record<string, ConfigTabKey>;
   ```
   （去掉旧的 `appearance: "general"` 映射——`appearance` 现在本身就是一个真实 tab key）

2. **`page.tsx`**：在 `const legacyTarget = params?.tab && ...` 这一行**之前**（即 `const params = await searchParams;` 之后）插入特判，注意必须在 `legacyTarget` 赋值表达式之前，否则 `skills` 不在 `LEGACY_CONFIG_TAB_REDIRECTS` 里、也不在新 `CONFIG_TABS` 里，会静默 fallback 到「常规」而不会跳转到 `/skills`：
   ```ts
   if (params?.tab === "skills") redirect("/skills");
   ```
   其余逻辑不动。

3. **`skill-center.tsx`** 布局重排（对照现有 L88-178）：
   - 顶部保留一个极窄的功能条（`h-8` 左右）只放 `<DragHandle />` + `<SidebarToggle />`，不再放 `<h1>设置</h1>`。
   - 关闭按钮改成绝对定位在整个弹窗右上角：`className="absolute right-3 top-3 z-10 ..."`，视觉上悬浮，不占布局行。
   - 下方 `flex flex-1 min-h-0` 容器包 `aside` + `main`，两者顶部对齐、`aside` 的 `border-r border-border` 天然贯穿到底（因为不再有跨两栏的顶部 header 行）。
   - `aside` 内部结构：顶部一个 `p-3 pb-2` 的搜索框（受控 input，state `query`，图标用 `Search01Icon`），下方 `nav` 用 `CONFIG_TABS.filter(t => t.label.includes(query.trim()))` 渲染 tab 列表；过滤后为空显示"未找到匹配项"。
   - `main` 顶部标题行去掉 `border-b`，减小 `py`（如 `pt-5 pb-4`），避免视觉大缝隙。
   - `activeTab === "general"` 渲染精简后的 `GeneralSettings`（去掉 `roleMode`/`onRoleModeChange` props，其余 props 不变）。
   - 新增 `activeTab === "appearance"` 渲染 `<AppearanceSettings />`（`app/config/appearance/appearance-settings.tsx`，已存在、无需改动，直接 import 使用）。
   - 新增 `activeTab === "personalization"` 渲染 `<PersonalizationSettings roleMode={roleMode} onRoleModeChange={(v) => { setRoleMode(v); scheduleClaudeSave(); }} />`（`roleMode`/`setRoleMode`/`scheduleClaudeSave` 已在 skill-center 顶部 state 里，原样复用，只是从 `general` 分支挪到这里）。
   - `activeTab === "model"` 分支不变（`ModelSettings` props 不变，用量已内聚进该组件本身，skill-center 不需要新增 props）。
   - 新增 `activeTab === "shortcuts"` 渲染 `<ShortcutsSettings />`（零 props）。
   - `activeTab === "about"` 不变。
   - 删除 `activeTab === "skills"` 分支和 `import { SkillCatalog } ...`、`import { UnderstandingSettings } ...` 改成 `import { PersonalizationSettings } from "./personalization/personalization-settings"`；同时新增 `import { AppearanceSettings } from "./appearance/appearance-settings"` 和 `import { ShortcutsSettings } from "./shortcuts/shortcuts-settings"`。
   - `isSettingsTab` 函数逻辑不变（仍然基于 `CONFIG_TABS`）。

4. **`general-settings.tsx`**：删除「主题」`SettingsSection`（含 `useTheme`/`THEMES` 引用）和「回复风格」`SettingsSection`；组件 props 类型里去掉 `roleMode`/`onRoleModeChange`；顶部 import 去掉不再使用的 `useTheme`/`Button`（如果 `Button` 仍被别处用到就保留，检查后再删）。

5. **`personalization-settings.tsx`**（新建，参照现有 `understanding-settings.tsx` 的组合写法）：
   ```tsx
   "use client";
   import { Button } from "@/components/ui/button";
   import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
   import { ProfileSettings } from "@/app/config/profile/profile-settings";
   import { MemorySettings } from "@/app/config/memory/memory-settings";

   export function PersonalizationSettings({
     roleMode,
     onRoleModeChange,
   }: {
     roleMode: "daily" | "tech";
     onRoleModeChange: (value: "daily" | "tech") => void;
   }) {
     return (
       <div className="flex flex-col gap-8">
         <SettingsSection
           title="回复风格"
           description={roleMode === "tech" ? "展示工具调用等工作过程，便于核查任务执行。" : "隐藏工作过程，只展示结论和必要说明。"}
         >
           <SettingsRow label="展示工作过程" hint="需要核查小财如何完成任务时开启">
             <div className="flex justify-end gap-2" role="group" aria-label="展示工作过程">
               {(["tech", "daily"] as const).map((mode) => (
                 <Button key={mode} variant={roleMode === mode ? "default" : "outline"} size="sm" onClick={() => onRoleModeChange(mode)}>
                   {mode === "tech" ? "展示" : "隐藏"}
                 </Button>
               ))}
             </div>
           </SettingsRow>
         </SettingsSection>
         <ProfileSettings />
         <MemorySettings />
       </div>
     );
   }
   ```
   （回复风格 JSX 原样从 `general-settings.tsx` 剪切过来，不要重新设计）
   完成后删除 `app/config/understanding/understanding-settings.tsx`。

6. **`model-settings.tsx`**：在现有唯一 `SettingsSection`（"模型连接"）之后追加一个新的 `SettingsSection title="用量" description="查看当前用量保护状态和重置周期。"`，内部渲染 `<UsageSettings />`（import 自 `@/app/config/usage/usage-settings`，与 `about-settings.tsx` 原来的写法一致）。

7. **`about-settings.tsx`**：删除"用量" `SettingsSection` 整块和 `import { UsageSettings } ...`。

8. **`shortcuts-settings.tsx`**（新建，参照 `app/shared/global-shortcuts.tsx` L97-150 的分组渲染逻辑，风格改成设置页表格）：
   ```tsx
   "use client";
   import { SettingsSection } from "@/app/config/settings-ui";
   import { Kbd } from "@/components/ui/kbd";
   import { useIsMac } from "@/app/shared/use-is-mac";
   import { formatShortcut, SHORTCUTS } from "@/app/shared/shortcuts";

   const GROUPS: Array<{ title: string; scopes: Array<"global" | "chat" | "composer"> }> = [
     { title: "对话输入", scopes: ["composer"] },
     { title: "全局与面板", scopes: ["global", "chat"] },
   ];

   export function ShortcutsSettings() {
     const isMac = useIsMac();
     return (
       <div className="flex flex-col">
         {GROUPS.map((group) => (
           <SettingsSection key={group.title} title={group.title}>
             <div className="flex flex-col">
               {SHORTCUTS.filter((s) => group.scopes.includes(s.scope)).map((shortcut) => (
                 <div key={shortcut.id} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-b-0">
                   <span className="text-body">
                     {shortcut.description}
                     {shortcut.webLimited ? <span className="ml-1 text-meta text-muted-foreground">(浏览器模式可能被占用)</span> : null}
                   </span>
                   <Kbd>{formatShortcut(shortcut.combo, isMac)}</Kbd>
                 </div>
               ))}
             </div>
           </SettingsSection>
         ))}
       </div>
     );
   }
   ```
   不加编辑/删除按钮（见「非目标」）。

9. **删除 `app/config/skill-catalog.tsx`**：确认 `skill-center.tsx` 已移除引用后直接删除文件（`grep -rn "skill-catalog" app` 应只剩自身文件，删除前再跑一次确认零其他引用）。

10. **`app-nav.tsx`**：
    - `type NavActive = "cockpit" | "chat" | "knowledge" | "config" | "files" | "agents" | "skills";`
    - 在"资料" `<Link href="/files">...</Link>`（现 L260-263）后面加：
      ```tsx
      <Link href="/skills" onClick={() => trackFeature("nav.skills")} className={navLinkClass(active === "skills")}>
        <HugeiconsIcon icon={NoteIcon} size={16} />
        <span>技能</span>
      </Link>
      ```
      图标用 `NoteIcon`（`skill-catalog.tsx`/`composer-skills.tsx` 里技能行已用它表示"技能"语义，保持一致），需要加进已有的 `@hugeicons/core-free-icons` import 列表。

11. **`app-shell.tsx`**：
    - L90 的 `active` 变量类型联合加 `"skills"`。
    - 在 `else if (pathname.startsWith("/agents"))` 和 `else if (pathname.startsWith("/config"))` 之间（或之后，顺序不重要）加：
      ```ts
      } else if (pathname.startsWith("/skills")) {
        active = "skills";
      ```

## 4. 测试与验证方式

本任务是纯前端 UI 重排，无后端/数据层改动，不需要跑 Python 测试套件。

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/practical-liskov-301d5e
npx tsc --noEmit   # 类型检查，确认新增/删除的 props、import 没有遗漏
```

- 需要新增的测试：无（纯展示型 UI 重排，本仓库对这类设置页历来没有专门单测，保持一致）。
- 明确不需要跑的部分：Python 侧测试（`FINANCE_AGENT_MOCK_AGENT=1` 那一套）与本任务无关，不跑。
- 手动验证（用 preview 工具在浏览器里过一遍，替代自动化测试）：
  1. 打开 `/config`，确认无"设置"标题，左上是搜索框，输入"模型"只剩"模型"一项，清空恢复 6 项。
  2. 依次点开 6 个 tab，确认内容对应成功标准里列的分布（尤其"个性化"里回复风格开关能正常切换、"模型"里能看到用量区块）。
  3. 访问 `/config?tab=skills`，确认被重定向到 `/skills`；访问 `/config?tab=understanding`、`?tab=usage`，确认分别落到 personalization / model。
  4. 主导航"资料"下方出现"技能"，点击跳转 `/skills` 且该项高亮。
  5. 截图留存于回复中。

## 5. 风险与开放问题

- `general-settings.tsx` 删掉 `useTheme`/`Button` 引用后，如果 `Button` 组件在该文件里没有其它用途会产生未使用 import 报错，implementer 需要顺手清掉。
- `ModelSettings`/`AboutSettings` 两处都会 import `UsageSettings`，需确认该组件本身没有"只能挂载一次"的副作用（如全局状态订阅），预期是纯展示+自身 fetch，风险低，但 implementer 完成后应过一遍 `usage-settings.tsx` 源码确认。
- 顶部功能条精简后 `DragHandle`/`SidebarToggle` 的可点击区域可能变窄，实施后需要在浏览器里用鼠标实际验证 mac 窗口拖拽区域与折叠按钮点击区未被压没（视觉走查即可，非自动化测试范围）。
- 搜索框只做 tab 标签过滤，不做设置项内容全文检索，与截图里"可以搜索设置的选项或内容"的表述有差距，已在非目标里写明,如用户验收时觉得不够，需要再开一轮迭代。
