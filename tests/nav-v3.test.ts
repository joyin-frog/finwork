/**
 * nav-v3.test.ts — 导航契约测试（随导航演进更新）
 *
 * 覆盖契约 5-7（导航结构）。注:cockpit-v3 曾把「技能」移出导航、让 /skills 重定向到 /config、
 * 并保留设置内的 skill-catalog 能力目录;后续迭代按用户要求把「技能」升为一级导航项(独立卡片页,
 * /skills 渲染 SkillsManager 不再重定向)、删除 skill-catalog.tsx、并把「资料」改名「知识库」指向
 * /knowledge。本测试已同步到当前契约:
 * 契约 5 — app/shared/app-nav.tsx：「智能体」为常驻目录(总览之后,子项直达/agents/<roleId>)；「技能」href="/skills" 为一级项；
 *           新对话/总览/知识库(/knowledge)/技能(/skills)/设置 保留
 * 契约 6 — app/skills/page.tsx 渲染 SkillsManager(卡片首页,不再重定向);skill-catalog.tsx 已删除
 * 契约 7 — app/shared/app-shell.tsx：active 映射含 "/agents"
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/nav-v3.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  appTabsReducer,
  appTabKeyFromRoute,
  pageTabFromRoute,
  resolveSelectedAppTabKey,
  type AppTabsState,
  conversationTabsReducer,
  syncCompletedConversationTitle,
  conversationDeleteResultForState,
  conversationDeleteDestination,
  conversationIdFromRoute,
  type ConversationTabsState,
} from "../app/shared/nav-state.tsx";

const ROOT = process.cwd();

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

export const navV3TestPromise = (async () => {
  // ── JOY-10 v2: 全应用标签 reducer + 路由映射 ─────────────────────────
  {
    const empty: AppTabsState = { tabs: [], activeKey: null, latestTitlesById: {} };
    const files = pageTabFromRoute("/files", "?view=grid");
    assert.deepEqual(files, {
      kind: "page",
      key: "page:files",
      pageKind: "files",
      title: "文件",
      href: "/files?view=grid",
    }, "JOY-10 v2 FAIL: 页面路由应映射为带最新 href 的单例标签");
    assert.equal(pageTabFromRoute("/chat/recent", "?id=7"), null, "JOY-10 v2 FAIL: recent 必须等 DB 标题后由 ChatPage 注册");
    assert.equal(appTabKeyFromRoute("/chat/recent", "?id=7"), "conversation:7", "JOY-10 v2 FAIL: 视觉激活态应以 recent 路由为事实源");
    assert.equal(appTabKeyFromRoute("/files", "?view=grid"), "page:files", "JOY-10 v2 FAIL: 视觉激活态应以页面路由为事实源");

    const selectionTabs = [
      files!,
      { kind: "conversation" as const, key: "conversation:9" as const, conversationId: 9, title: "真实标题", href: "/chat/recent?id=9" },
    ];
    assert.equal(
      resolveSelectedAppTabKey("page:chat-new", "conversation:9", selectionTabs),
      "conversation:9",
      "JOY-10 v2.1 FAIL: chat-new 原位升级后、路由 replace 提交前应保持真实会话标签选中"
    );
    assert.equal(
      resolveSelectedAppTabKey("page:files", "conversation:9", selectionTabs),
      "page:files",
      "JOY-10 v2.1 FAIL: 已存在的 routeKey 必须优先于 reducer activeKey"
    );
    assert.equal(
      resolveSelectedAppTabKey("page:knowledge", "page:files", selectionTabs),
      null,
      "JOY-10 v2.1 FAIL: 普通页面路由尚未建签时不得错误高亮旧标签"
    );

    const filesOpened = appTabsReducer(empty, { type: "openPage", tab: files! });
    const filesUpdated = appTabsReducer(filesOpened, {
      type: "openPage",
      tab: { ...files!, href: "/files?view=list" },
    });
    assert.equal(filesUpdated.tabs.length, 1, "JOY-10 v2 FAIL: 同类页面只能有一个标签");
    assert.equal(filesUpdated.tabs[0].href, "/files?view=list", "JOY-10 v2 FAIL: 页面单例应保留最新 href");

    const newChat = appTabsReducer(filesUpdated, {
      type: "openPage",
      tab: { kind: "page", key: "page:chat-new", pageKind: "chat-new", title: "新对话", href: "/chat/new" },
    });
    const upgraded = appTabsReducer(newChat, {
      type: "upgradeChatNew",
      tab: { kind: "conversation", key: "conversation:9", conversationId: 9, title: "新对话", href: "/chat/recent?id=9" },
    });
    assert.deepEqual(upgraded.tabs.map((tab) => tab.key), ["page:files", "conversation:9"], "JOY-10 v2 FAIL: chat:new 应原位升级为真实会话");
    assert.equal(upgraded.activeKey, "conversation:9", "JOY-10 v2 FAIL: 升级后应激活真实会话");

    const existingConversation = appTabsReducer(upgraded, {
      type: "openConversation",
      tab: { kind: "conversation", key: "conversation:10", conversationId: 10, title: "已有", href: "/chat/recent?id=10" },
    });
    const withAnotherNew = appTabsReducer(existingConversation, {
      type: "openPage",
      tab: { kind: "page", key: "page:chat-new", pageKind: "chat-new", title: "新对话", href: "/chat/new" },
    });
    const dedupedUpgrade = appTabsReducer(withAnotherNew, {
      type: "upgradeChatNew",
      tab: { kind: "conversation", key: "conversation:10", conversationId: 10, title: "权威标题", href: "/chat/recent?id=10" },
    });
    assert.deepEqual(dedupedUpgrade.tabs.map((tab) => tab.key), ["page:files", "conversation:9", "conversation:10"], "JOY-10 v2 FAIL: 升级到已有会话时应去重");
    assert.equal(dedupedUpgrade.tabs[2].title, "权威标题", "JOY-10 v2 FAIL: 去重升级应刷新权威标题");

    const activatedMiddle = appTabsReducer(dedupedUpgrade, { type: "activate", key: "conversation:9" });
    const closedMiddle = appTabsReducer(activatedMiddle, { type: "close", key: "conversation:9" });
    assert.equal(closedMiddle.activeKey, "conversation:10", "JOY-10 v2 FAIL: 混合标签关闭当前项应优先右邻");
    const closedAll = appTabsReducer(closedMiddle, { type: "closeAll" });
    assert.deepEqual(closedAll.tabs.map((tab) => tab.key), ["page:cockpit"], "JOY-10 v2 FAIL: 关闭全部应创建 cockpit 兜底标签");
  }

  // ── F1 reviewer round 1: 完成态真实标题接线行为 ───────────────────────────
  {
    const localTitles: string[] = [];
    const navTitles: Array<{ id: number; title: string }> = [];
    const sinks = {
      setLocalTitle: (title: string) => localTitles.push(title),
      updateNavTitle: (id: number, title: string) => navTitles.push({ id, title }),
    };
    assert.equal(
      syncCompletedConversationTitle({ status: "done", conversationId: 17, finalTitle: "完成标题" }, sinks),
      true,
      "F1 FAIL: done 应执行标题同步"
    );
    assert.equal(
      syncCompletedConversationTitle({ status: "incomplete", conversationId: 18, finalTitle: "部分完成标题" }, sinks),
      true,
      "F1 FAIL: incomplete 应执行标题同步"
    );
    assert.deepEqual(localTitles, ["完成标题", "部分完成标题"], "F1 FAIL: 完成态应把真实最终标题传给本地 H1 sink");
    assert.deepEqual(
      navTitles,
      [{ id: 17, title: "完成标题" }, { id: 18, title: "部分完成标题" }],
      "F1 FAIL: 完成态应把真实 conversation ID + final title 传给 Nav sink"
    );
    assert.equal(
      syncCompletedConversationTitle({ status: "error", conversationId: 19, finalTitle: "不应同步" }, sinks),
      false,
      "F1 FAIL: 非完成态不得同步最终标题"
    );
    assert.equal(navTitles.length, 2, "F1 FAIL: error 不得调用 Nav sink");
  }

  // ── JOY-10: 会话标签纯 reducer ────────────────────────────────────────────
  {
    const empty: ConversationTabsState = { tabs: [], activeId: null, latestTitlesById: {} };
    const titleBeforeOpen = conversationTabsReducer(empty, { type: "updateTitle", id: 4, title: "权威标题" });
    const openedAfterTitle = conversationTabsReducer(titleBeforeOpen, { type: "open", tab: { id: 4, title: "旧标题" } });
    assert.equal(openedAfterTitle.tabs[0].title, "权威标题", "JOY-10 FAIL: 标题先到、标签后开时不得被旧标题覆盖");

    const one = conversationTabsReducer(empty, { type: "open", tab: { id: 1, title: "一" } });
    const two = conversationTabsReducer(one, { type: "open", tab: { id: 2, title: "二" } });
    const three = conversationTabsReducer(two, { type: "open", tab: { id: 3, title: "三" } });

    const deduped = conversationTabsReducer(three, { type: "open", tab: { id: 2, title: "二（新）" } });
    assert.deepEqual(deduped.tabs.map((tab) => tab.id), [1, 2, 3], "JOY-10 FAIL: 重复打开同一会话不应新增标签");
    assert.equal(deduped.activeId, 2, "JOY-10 FAIL: 重复打开应激活原标签");
    assert.equal(deduped.tabs[1].title, "二（新）", "JOY-10 FAIL: DB 权威标题应刷新原标签");

    const closeMiddle = conversationTabsReducer(deduped, { type: "close", id: 2 });
    assert.deepEqual(closeMiddle.tabs.map((tab) => tab.id), [1, 3], "JOY-10 FAIL: 应删除指定标签");
    assert.equal(closeMiddle.activeId, 3, "JOY-10 FAIL: 关闭当前标签应优先激活右邻");

    const closeRight = conversationTabsReducer(closeMiddle, { type: "close", id: 3 });
    assert.equal(closeRight.activeId, 1, "JOY-10 FAIL: 没有右邻时应激活左邻");

    const reopened = conversationTabsReducer(closeRight, { type: "open", tab: { id: 2, title: "二" } });
    const activated = conversationTabsReducer(reopened, { type: "activate", id: 1 });
    const closeInactive = conversationTabsReducer(activated, { type: "close", id: 2 });
    assert.equal(closeInactive.activeId, 1, "JOY-10 FAIL: 关闭非当前标签不应改变 activeId");

    const removedCurrent = conversationTabsReducer(three, { type: "removeDeleted", id: 2 });
    assert.equal(removedCurrent.activeId, 3, "JOY-10 FAIL: 删除当前对话也应优先激活右邻");
    const removedInactive = conversationTabsReducer(
      conversationTabsReducer(three, { type: "activate", id: 1 }),
      { type: "removeDeleted", id: 3 }
    );
    assert.equal(removedInactive.activeId, 1, "JOY-10 FAIL: 删除非当前对话不应改变 activeId");

    const titled = conversationTabsReducer(three, { type: "updateTitle", id: 2, title: "新标题" });
    assert.equal(titled.tabs[1].title, "新标题", "JOY-10 FAIL: 标题更新应同步到已打开标签");

    const metaOpened = conversationTabsReducer(empty, { type: "open", tab: { id: 5, title: "新对话" } });
    const doneTitled = conversationTabsReducer(metaOpened, { type: "updateTitle", id: 5, title: "生成后的真实标题" });
    assert.equal(doneTitled.tabs[0].title, "生成后的真实标题", "F1 FAIL: meta 打开的新会话标签应接受 done 最终标题");

    const closedAll = conversationTabsReducer(three, { type: "closeAll" });
    assert.deepEqual(closedAll.tabs, [], "JOY-10 FAIL: 关闭全部应清空标签");
    assert.equal(closedAll.activeId, null, "JOY-10 FAIL: 关闭全部应清空 activeId");

    const deleted = conversationTabsReducer(openedAfterTitle, { type: "removeDeleted", id: 4 });
    assert.equal(deleted.latestTitlesById[4], undefined, "JOY-10 FAIL: 删除对话应清理运行期标题缓存");
  }

  // ── JOY-10: DELETE 返回后的实时路由决策 ──────────────────────────────────
  {
    const result = { deletedId: 2, activeId: 3 };
    assert.equal(conversationIdFromRoute("/chat/recent", "?id=2"), 2, "JOY-10 FAIL: 应解析当前历史对话 ID");
    assert.equal(conversationIdFromRoute("/cockpit", "?id=2"), null, "JOY-10 FAIL: 非对话页面不得误认当前会话");
    assert.equal(conversationDeleteDestination(result, 2), "/chat/recent?id=3", "JOY-10 FAIL: 仍停留在被删会话时应跳相邻标签");
    assert.equal(conversationDeleteDestination({ deletedId: 2, activeId: null }, 2), "/cockpit", "JOY-10 FAIL: 无相邻标签时应回总览");
    assert.equal(conversationDeleteDestination(result, 3), null, "JOY-10 FAIL: DELETE 等待期间切到其他会话后不得拉回");
    assert.equal(conversationDeleteDestination(result, null), null, "JOY-10 FAIL: DELETE 等待期间切到其他页面后不得拉回");

    const waitingStart: ConversationTabsState = {
      tabs: [{ id: 1, title: "左" }, { id: 2, title: "删除目标" }, { id: 3, title: "右" }],
      activeId: 2,
      latestTitlesById: { 1: "左", 2: "删除目标", 3: "右" },
    };
    const afterDeleteStarted = conversationTabsReducer(waitingStart, { type: "removeDeleted", id: 2 });
    assert.equal(afterDeleteStarted.activeId, 3, "JOY-10 FAIL: 删除开始时右邻应成为候选");
    const afterNeighborClosed = conversationTabsReducer(afterDeleteStarted, { type: "close", id: 3 });
    const liveResult = conversationDeleteResultForState(2, afterNeighborClosed);
    assert.equal(liveResult.activeId, 1, "JOY-10 FAIL: 等待期间右邻关闭后应基于实时状态改用左邻");
    assert.equal(conversationDeleteDestination(liveResult, 2), "/chat/recent?id=1", "JOY-10 FAIL: DELETE 完成不得跳到已关闭邻居");
  }

  // ── F3: /agents/<roleId> 各开独立应用标签，标题用角色中文名 ──────────────
  {
    const analyst = pageTabFromRoute("/agents/analyst", "");
    assert.ok(analyst, "F3 FAIL: /agents/<roleId> 应产出标签");
    assert.equal(analyst!.key, "page:agents:analyst", "F3 FAIL: 角色标签 key 应按 roleId 分开（page:agents:<roleId>）");
    assert.equal(analyst!.pageKind, "agents", "F3 FAIL: pageKind 仍应为 agents（图标映射复用）");
    assert.equal(analyst!.title, "经营分析师", "F3 FAIL: 标题应为角色中文名（ROLE_LABELS 兜底），不是统一「智能体」");
    assert.equal(analyst!.href, "/agents/analyst", "F3 FAIL: href 应保留完整路径");

    const bookkeeper = pageTabFromRoute("/agents/bookkeeper", "?task=7");
    assert.equal(bookkeeper!.key, "page:agents:bookkeeper", "F3 FAIL: 不同角色应产出不同 key");
    assert.equal(bookkeeper!.title, "记账专员", "F3 FAIL: 记账专员标题应正确映射");
    assert.equal(bookkeeper!.href, "/agents/bookkeeper?task=7", "F3 FAIL: search 应拼进 href");

    // 未知 roleId：降级用 roleId 本身兜底，不崩不返回 null
    const unknown = pageTabFromRoute("/agents/does-not-exist", "");
    assert.equal(unknown!.title, "does-not-exist", "F3 FAIL: 未知 roleId 应降级为 roleId 本身，不得抛错或空标题");

    // 裸 /agents（旧花名册）保持原「智能体」单例标签，不受角色分标签影响
    const roster = pageTabFromRoute("/agents", "");
    assert.equal(roster!.key, "page:agents", "F3 FAIL: 裸 /agents 仍应是单例 page:agents");
    assert.equal(roster!.title, "智能体", "F3 FAIL: 裸 /agents 标题应保持「智能体」");

    // reducer 层：两个角色标签应并存，不互相覆盖（复制对话标签的分 key 模式）
    const empty: AppTabsState = { tabs: [], activeKey: null, latestTitlesById: {} };
    const opened1 = appTabsReducer(empty, { type: "openPage", tab: analyst! });
    const opened2 = appTabsReducer(opened1, { type: "openPage", tab: bookkeeper! });
    assert.deepEqual(
      opened2.tabs.map((t) => t.key),
      ["page:agents:analyst", "page:agents:bookkeeper"],
      "F3 FAIL: 切换角色不应覆盖另一角色的标签，应各自独立"
    );
    assert.equal(opened2.activeKey, "page:agents:bookkeeper", "F3 FAIL: 新开标签应激活自己");
  }

  // ── 抛光: 侧栏角色行使用方形语义图标，只在有事时显示状态点 ──
  {
    const navSrc = src("app/shared/app-nav.tsx");
    const roleRowBody = navSrc.slice(navSrc.indexOf("function renderRoleRow"), navSrc.indexOf("function renderConversationRow"));
    assert.ok(roleRowBody.includes("ROLE_UI[r.roleId"), "抛光 FAIL: 角色图标应使用岗位 tone");
    assert.ok(roleRowBody.includes("roleNavIcon"), "抛光 FAIL: 角色图标应经 roleNavIcon 按 ROLE_UI.iconName 解析");
    assert.ok(!navSrc.includes("ROLE_NAV_ICONS"), "抛光 FAIL: 不得再维护与 ROLE_UI 脱节的 ROLE_NAV_ICONS");
    const roleIconsSrc = src("lib/domain/role-icons.ts");
    assert.ok(roleIconsSrc.includes("ROLE_UI"), "抛光 FAIL: role-icons 应以 ROLE_UI.iconName 为唯一来源");
    assert.ok(roleRowBody.includes("rounded"), "抛光 FAIL: 角色图标槽应为轻圆角方形，不得使用圆形头像");
    assert.ok(!roleRowBody.includes("r.name.slice(0, 1)"), "抛光 FAIL: 角色图标不应继续使用圆形汉字头像");
    assert.ok(!roleRowBody.includes('"var(--tone-neutral)"'), "抛光 FAIL: 空闲角色不应常显中性圆点");
    assert.ok(!roleRowBody.includes('"\u7a7a\u95f2"'), "抛光 FAIL: 空闲状态不应生成常显提示");
    assert.ok(roleRowBody.includes("dotTone &&"), "抛光 FAIL: 只有进行中或待拍板时才应显示状态点");
    assert.ok(roleRowBody.includes("aria-label={dotLabel}"), "抛光 FAIL: 有事状态点应带 aria-label");
    assert.ok(!navSrc.includes("AiBrain01Icon"), "抛光 FAIL: 智能体分组标题不应显示图标");
  }

  // ── 契约 5a: app-nav.tsx「智能体」为常驻目录，子项直达角色工作台 ────────────
  // IA 重构（docs/spec/design-agents-ia.md）：父项不再导航到 /agents 落地页，
  // 标题只承担目录标识；子列表始终渲染并直达 /agents/<roleId> 工作台。
  {
    const navSrc = src("app/shared/app-nav.tsx");
    const navStateSrc = src("app/shared/nav-state.tsx");
    assert.ok(
      navSrc.includes("智能体"),
      "C5a FAIL: app-nav.tsx 应含「智能体」文案"
    );
    assert.ok(
      !navSrc.includes("setAgentsOpen") && !navSrc.includes("agentsOpen"),
      "C5a FAIL: 「智能体」目录应常驻，不得保留折叠状态或开关"
    );
    assert.ok(
      !navStateSrc.includes("setAgentsOpen") && !navStateSrc.includes("agentsOpen"),
      "C5a FAIL: NavState 不得保留已废弃的智能体折叠状态"
    );
    assert.ok(
      navSrc.includes('data-nav-agent-directory="always"'),
      "C5a FAIL: 智能体常驻目录应有稳定结构标记"
    );
    assert.ok(
      navSrc.includes("/agents/${"),
      "C5a FAIL: 角色子项应直达各自工作台 /agents/<roleId>"
    );
  }

  // ── JOY-10: 关键接线契约 ──────────────────────────────────────────────────
  {
    const navStateSrc = src("app/shared/nav-state.tsx");
    const chatPageSrc = src("app/chat/chat-page.tsx");
    const shellSrc = src("app/shared/app-shell.tsx");
    const titleUpdateBody = navStateSrc.slice(
      navStateSrc.indexOf("const updateConversationTitle"),
      navStateSrc.indexOf("useEffect", navStateSrc.indexOf("const updateConversationTitle"))
    );
    const commitRenameBody = navStateSrc.slice(
      navStateSrc.indexOf("const commitRename"),
      navStateSrc.indexOf("const startDelete")
    );
    const completionEffectBody = chatPageSrc.slice(
      chatPageSrc.indexOf("if (!turn || !turnKey) return;"),
      chatPageSrc.indexOf("const finishedKey = turnKey;")
    );
    assert.ok(navStateSrc.includes("appTabsReducer"), "JOY-10 v2 FAIL: NavState 应使用统一 AppTab reducer");
    assert.ok(navStateSrc.includes("openConversationTab"), "JOY-10 FAIL: NavState 应暴露打开会话标签动作");
    assert.ok(chatPageSrc.includes("openConversationTab"), "JOY-10 FAIL: ChatPage 应在 DB/meta 权威入口注册标签");
    assert.ok(titleUpdateBody.includes('type: "updateTitle"'), "JOY-10 FAIL: SSE/DB 标题入口应同步标签标题");
    assert.ok(commitRenameBody.includes('type: "updateTitle"'), "JOY-10 FAIL: 侧栏手工重命名应同步标签标题");
    assert.ok(
      completionEffectBody.includes("syncCompletedConversationTitle"),
      "F1 FAIL: 新会话 done/incomplete 应复用已行为测试的完成态标题同步逻辑"
    );
    assert.ok(!shellSrc.includes("AppTabBar") && !shellSrc.includes("RouteTabSync"), "导航精简 FAIL: AppShell 不应保留顶部标签栏接线");
    assert.ok(chatPageSrc.includes("upgradeNewConversationTab"), "JOY-10 v2 FAIL: meta 应将 chat:new 原位升级为真实会话");
    assert.ok(chatPageSrc.includes("router.replace(`/chat/recent?id=${cid}`)"), "JOY-10 v2 FAIL: meta 后应通过 App Router replace 进入 recent");
    assert.ok(!navStateSrc.includes('localStorage.setItem("conversation'), "JOY-10 FAIL: v1 不应持久化会话标签");
  }

  // ── 契约 5b: 「智能体」作为常驻目录，位于「置顶」之前 ─────────────────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    const agentsIdx = navSrc.indexOf('data-nav-agent-directory="always"');
    const pinnedIdx = navSrc.indexOf("setPinnedOpen(!pinnedOpen)");
    assert.ok(
      agentsIdx !== -1,
      "C5b FAIL: app-nav.tsx 应含常驻智能体目录"
    );
    assert.ok(
      pinnedIdx !== -1,
      "C5b FAIL: app-nav.tsx 应含「置顶」展开/收起按钮"
    );
    assert.ok(
      agentsIdx < pinnedIdx,
      `C5b FAIL: 「智能体」（pos ${agentsIdx}）应位于「置顶」（pos ${pinnedIdx}）之前`
    );
    const agentsHeader = navSrc.slice(agentsIdx, navSrc.indexOf("agentRoster.length", agentsIdx));
    assert.ok(
      agentsHeader.includes("min-h-8") && agentsHeader.includes("px-3"),
      "C5b FAIL: 「智能体」标题应使用 32px 高度与统一水平缩进"
    );
    assert.ok(
      !agentsHeader.includes("UserGroupIcon"),
      "C5b FAIL: 「智能体」分组标题不应显示图标"
    );
    assert.ok(
      navSrc.includes("sidebar-nav-scroll") && navSrc.includes("gap-5") && navSrc.includes("overflow-y-auto"),
      "C5b FAIL: 侧栏中部滚动区应使用 20px 大分组间距"
    );
    assert.ok(
      navSrc.includes('className="flex flex-col gap-0 px-2 pb-5 shrink-0"'),
      "C5b FAIL: 一级菜单行应连续排列，同时与智能体目录保留 20px 间距"
    );
    // 一级导航以下共用一条滚动条：智能体与置顶/最近同在 data-nav-scroll 内。
    const scrollIdx = navSrc.indexOf('data-nav-scroll=""');
    const agentDirIdx = navSrc.indexOf('data-nav-agent-directory="always"');
    const pinnedIdx2 = navSrc.indexOf("setPinnedOpen(!pinnedOpen)");
    assert.ok(scrollIdx > -1 && agentDirIdx > scrollIdx, "C5b FAIL: 智能体应位于统一滚动容器内");
    assert.ok(pinnedIdx2 > agentDirIdx, "C5b FAIL: 置顶应与智能体同属统一滚动区且位于其后");
    assert.ok(
      navSrc.includes("sidebar-nav-edge-top") && navSrc.includes("sidebar-nav-edge-bottom"),
      "C5b FAIL: 滚动区应有上下边缘渐隐"
    );
    assert.ok(
      navSrc.includes("data-nav-scroll-top") && navSrc.includes("data-nav-scroll-bottom"),
      "C5b FAIL: 边缘渐隐应按滚动位置显隐"
    );
    const globals = src("app/globals.css");
    assert.match(globals, /\.sidebar-nav-edge-top/, "C5b FAIL: globals 应定义顶部边缘渐隐");
    assert.match(globals, /\.sidebar-nav-edge-bottom/, "C5b FAIL: globals 应定义底部边缘渐隐");
    assert.match(globals, /backdrop-filter:\s*blur/, "C5b FAIL: 边缘渐隐应含轻 blur");
    // 「最近」默认策略：有置顶收起、无置顶展开。
    assert.ok(
      navSrc.includes("setRecentOpen(!hasPinnedNow)"),
      "C5b FAIL: 应根据是否有置顶设置「最近」默认开合"
    );
    assert.ok(
      navSrc.includes("pinnedPresenceRef"),
      "C5b FAIL: 「最近」默认策略应只在置顶有无变化时套用"
    );
  }

  // ── 设计语言: 参考图提炼出的侧栏节奏必须写入长期 UI 约定 ────────────────
  {
    const conventions = src("docs/ui-conventions.md");
    assert.match(conventions, /紧凑行、宽分组/, "设计语言 FAIL: 应记录侧栏的核心节奏");
    assert.match(conventions, /20px/, "设计语言 FAIL: 应记录密集侧栏的大分组间距");
    assert.match(conventions, /一条滚动条/, "设计语言 FAIL: 应记录一级导航以下共用滚动");
    assert.match(conventions, /渐隐/, "设计语言 FAIL: 应记录侧栏滚动区边缘渐隐");
    assert.match(conventions, /有置顶时/, "设计语言 FAIL: 应记录「最近」相对置顶的默认开合策略");
    assert.match(conventions, /双轴对齐/, "设计语言 FAIL: 应记录图形轴与文字轴对齐规则");
    assert.match(conventions, /常驻目录/, "设计语言 FAIL: 应记录短目录默认常驻的原则");
  }

  // ── 契约 5c: 「技能」为一级导航项（导航区含 href="/skills"）─────────────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    assert.ok(
      navSrc.includes('href="/skills"'),
      "C5c FAIL: app-nav.tsx 应含 href=\"/skills\" 导航项（「技能」已升为一级项）"
    );
    assert.ok(
      navSrc.includes("技能"),
      "C5c FAIL: app-nav.tsx 应含「技能」文案"
    );
  }

  // ── 契约 5d: 保留项核验——新对话/总览/知识库(/knowledge)/技能/设置 ───────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    assert.ok(
      navSrc.includes('href="/chat/new"'),
      "C5d FAIL: app-nav.tsx 应保留「新对话」导航项 href=\"/chat/new\""
    );
    assert.ok(
      navSrc.includes('href="/cockpit"'),
      "C5d FAIL: app-nav.tsx 应保留「总览」导航项 href=\"/cockpit\""
    );
    // 「资料」已改名「知识库」并指向 /knowledge
    assert.ok(
      navSrc.includes('href="/knowledge"') && navSrc.includes("知识库"),
      "C5d FAIL: app-nav.tsx 应含「知识库」导航项 href=\"/knowledge\"（原「资料」已改名并改指 /knowledge）"
    );
    // 设置（/config）
    assert.ok(
      navSrc.includes('href="/config"'),
      "C5d FAIL: app-nav.tsx 应保留设置入口 href=\"/config\""
    );
  }

  // ── 契约 6: /skills 渲染 SkillsManager 卡片首页（不再重定向）;skill-catalog 已删 ──
  {
    assert.ok(
      exists("app/skills/page.tsx"),
      "C6 FAIL: app/skills/page.tsx 应存在（/skills 卡片首页）"
    );
    const skillsPageSrc = src("app/skills/page.tsx");
    assert.ok(
      skillsPageSrc.includes("SkillsManager"),
      "C6 FAIL: app/skills/page.tsx 应渲染 SkillsManager（技能卡片首页）"
    );
    assert.ok(
      !skillsPageSrc.includes('redirect('),
      "C6 FAIL: /skills 不应再重定向（已是真实卡片页）"
    );
    // 旧的设置内技能能力目录 skill-catalog.tsx 已删除（技能改由 /skills 一级页承接）
    assert.ok(
      !exists("app/config/skill-catalog.tsx"),
      "C6 FAIL: app/config/skill-catalog.tsx 应已删除（技能能力已迁到 /skills）"
    );
  }

  // ── 契约 7: app-shell.tsx active 映射含 "/agents" ──────────────────────────
  {
    const shellSrc = src("app/shared/app-shell.tsx");
    // active 类型定义或映射应含 agents
    assert.ok(
      shellSrc.includes('"agents"') || shellSrc.includes("'agents'"),
      "C7 FAIL: app-shell.tsx active 映射应含 \"agents\" 值"
    );
    // /agents 路径判断应存在（pathname.startsWith 或类似）
    assert.ok(
      shellSrc.includes("/agents"),
      "C7 FAIL: app-shell.tsx 应含 /agents 路径判断（active 映射）"
    );
  }

  // ── 契约 8: 侧栏缩放手柄为中部短线，不再覆盖整栏高度 ───────────────────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    const dividerSrc = src("app/shared/vertical-resize-divider.tsx");
    const resizeStart = navSrc.indexOf('aria-label="调整侧栏宽度"');
    const resizeBlock = navSrc.slice(Math.max(0, resizeStart - 900), resizeStart + 300);
    assert.ok(resizeStart !== -1, "C8 FAIL: 侧栏应保留键鼠可操作的宽度调整手柄");
    assert.ok(
      resizeBlock.includes("VerticalResizeDivider") && resizeBlock.includes("top-0 bottom-0"),
      "C8 FAIL: 侧栏应复用整高纵向拖拽分隔区"
    );
    assert.ok(dividerSrc.includes("self-stretch") && dividerSrc.includes("w-1"), "C8 FAIL: 共享分隔区应整高可拖且保持 4px 命中宽度");
    assert.ok(!dividerSrc.includes("before:"), "C8 FAIL: 共享分隔区不应再绘制独立短手柄");
    assert.ok(
      !resizeBlock.includes("w-[5px]"),
      "C8 FAIL: 拖拽分隔区不应使用 5px 粗条"
    );
  }

  console.log("nav-v3: JOY-10 + C5–C8 checks passed ✓");
})();
