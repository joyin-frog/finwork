import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// 技能数据层 CRUD + 文件操作行为测试(新模型)。用临时目录 + 环境变量隔离,真实读写文件:
// - 内置技能只读且恒启用(不可启停/改/删/改文件);用户技能全可改(描述/正文/任意文件)+可启停。
// - 名字内置/用户互斥;喂给 SDK 的 plugins/skills 计算;路径穿越必须被拒。
// - frontmatter 的 title/summary 纯展示字段要解析并经 /api/skills 返回。
export const skillsStoreTestPromise = (async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "finance-agent-skills-store-"));
  const bundledRoot = path.join(fixture, "bundled");
  const userRoot = path.join(fixture, "user-skills");
  const statePath = path.join(fixture, "skills-state.json");

  // 内置 fixture:1 个带脚本的 demo 技能。
  mkdirSync(path.join(bundledRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(bundledRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "finance-skills", version: "0.1.0" }),
  );
  const demoDir = path.join(bundledRoot, "skills", "demo");
  mkdirSync(path.join(demoDir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(demoDir, "SKILL.md"),
    `---\nname: demo\ntitle: 演示技能\nsummary: 一句给财务用户看的演示说明。\ndescription: 内置演示技能\n---\n\n# Demo\n正文。\n`,
  );
  writeFileSync(path.join(demoDir, "scripts", "run.py"), "print('hi')\n");

  process.env.FINANCE_AGENT_BUNDLED_PLUGIN_DIR = bundledRoot;
  process.env.FINANCE_AGENT_USER_PLUGIN_DIR = userRoot;
  process.env.FINANCE_AGENT_SKILLS_STATE_PATH = statePath;

  const store = await import("../lib/agent/skills-store.ts");

  try {
    // ── AC-1: 内置技能 read-only 标记 ─────────────────────────────────
    let list = await store.listSkills();
    const demo = list.find((s) => s.name === "demo");
    assert.ok(demo, "AC-1 FAIL: 应列出内置 demo");
    assert.equal(demo.source, "bundled");
    assert.equal(demo.editable, false, "AC-1 FAIL: 内置技能 editable 应为 false");
    assert.equal(demo.enabled, true);
    assert.equal(demo.title, "演示技能", "AC-1 FAIL: 应解析 frontmatter title");
    assert.equal(demo.summary, "一句给财务用户看的演示说明。", "AC-1 FAIL: 应解析 frontmatter summary");

    // ── AC-2: 干净态 SDK 配置走快路径 ─────────────────────────────────
    let cfg = await store.getSkillSdkConfig();
    assert.equal(cfg.plugins.length, 1);
    assert.equal(cfg.skills, "all", "AC-2 FAIL: 干净态应为 'all'");

    // ── AC-3: 新建用户技能;重名(内置)拒绝;非法名拒绝 ───────────────
    const created = await store.createSkill("mine", { description: "我的技能:测试", body: "# Mine\n步骤。" });
    assert.equal(created.source, "user");
    assert.equal(created.editable, true, "AC-3 FAIL: 用户技能 editable 应为 true");
    assert.ok(existsSync(path.join(userRoot, "skills", "mine", "SKILL.md")));
    await assert.rejects(() => store.createSkill("demo", { description: "x", body: "y" }), /已存在|exists/, "AC-3 FAIL: 与内置重名应拒绝");
    await assert.rejects(() => store.createSkill("../evil", { description: "x", body: "y" }), /不合法|invalid/, "AC-3 FAIL: 非法名应拒绝");

    // ── AC-4: 编辑——内置抛 read_only;用户可改 ─────────────────────────
    await assert.rejects(
      () => store.updateSkill("demo", { description: "x", body: "y" }),
      (err: unknown) => err instanceof store.SkillError && err.code === "read_only",
      "AC-4 FAIL: 编辑内置技能应抛 read_only",
    );
    const updated = await store.updateSkill("mine", { description: "改后描述", body: "# Mine v2\n新正文。" });
    assert.match(updated.body, /新正文/);
    assert.equal((await store.getSkill("mine"))?.description, "改后描述");

    // ── AC-5: 删除——内置抛 read_only;用户可删 ─────────────────────────
    await assert.rejects(
      () => store.deleteSkill("demo"),
      (err: unknown) => err instanceof store.SkillError && err.code === "read_only",
      "AC-5 FAIL: 删除内置技能应抛 read_only",
    );

    // ── AC-6: 内置技能不可启停(恒启用),历史误关标记被忽略;用户技能可启停 ──
    await assert.rejects(
      () => store.setSkillEnabled("demo", false),
      (err: unknown) => err instanceof store.SkillError && err.code === "read_only",
      "AC-6 FAIL: 停用内置技能应抛 read_only",
    );
    // 历史遗留的停用标记:读取时一律视为启用,SDK 配置也不剔除(修复历史误关)
    writeFileSync(statePath, `${JSON.stringify({ disabled: ["demo"] })}\n`);
    list = await store.listSkills();
    assert.equal(list.find((s) => s.name === "demo")?.enabled, true, "AC-6 FAIL: 内置技能应忽略停用标记(恒启用)");
    cfg = await store.getSkillSdkConfig();
    assert.ok(Array.isArray(cfg.skills), "AC-6 FAIL: 有用户技能时 skills 应为白名单数组");
    assert.ok((cfg.skills as string[]).includes("finance-skills:demo"), "AC-6 FAIL: 内置 demo 不应被停用标记剔除");
    // 用户技能仍可停用,并从 SDK 白名单剔除
    await store.setSkillEnabled("mine", false);
    list = await store.listSkills();
    assert.equal(list.find((s) => s.name === "mine")?.enabled, false, "AC-6 FAIL: 用户技能应可停用");
    cfg = await store.getSkillSdkConfig();
    const skills = cfg.skills as string[];
    assert.equal(cfg.plugins.length, 2, "AC-6 FAIL: 应注册内置+用户两个 plugin");
    assert.ok(!skills.includes("user-skills:mine"), "AC-6 FAIL: 停用的用户技能应被剔除");
    assert.ok(skills.includes("finance-skills:demo"), "AC-6 FAIL: 内置 demo 应始终在白名单");
    await store.setSkillEnabled("mine", true);
    writeFileSync(statePath, `${JSON.stringify({ disabled: [] })}\n`);

    // ── AC-7: 文件操作(用户技能)——列/写/读/删;内置抛 read_only ──────
    let files = await store.listSkillFiles("mine");
    assert.ok(files.some((f) => f.path === "SKILL.md"), "AC-7 FAIL: 文件树应含 SKILL.md");
    await store.writeSkillFile("mine", "scripts/run.py", "print('mine')\n");
    assert.ok(existsSync(path.join(userRoot, "skills", "mine", "scripts", "run.py")), "AC-7 FAIL: 写新文件应落盘");
    files = await store.listSkillFiles("mine");
    assert.ok(files.some((f) => f.path === "scripts/run.py"), "AC-7 FAIL: 文件树应含新写文件");
    assert.equal((await store.readSkillFile("mine", "scripts/run.py")).content, "print('mine')\n");
    await store.deleteSkillFile("mine", "scripts/run.py");
    assert.ok(!existsSync(path.join(userRoot, "skills", "mine", "scripts", "run.py")), "AC-7 FAIL: 删文件应生效");
    await assert.rejects(
      () => store.writeSkillFile("demo", "scripts/x.py", "x"),
      (err: unknown) => err instanceof store.SkillError && err.code === "read_only",
      "AC-7 FAIL: 写内置技能文件应抛 read_only",
    );

    // ── AC-7b: SKILL.md 删除守卫不能被路径归一化绕过 ────────────────────
    await assert.rejects(
      () => store.deleteSkillFile("mine", "SKILL.md"),
      (err: unknown) => err instanceof store.SkillError && err.code === "invalid_path",
      "AC-7b FAIL: 字面量 SKILL.md 应拒删",
    );
    await assert.rejects(
      () => store.deleteSkillFile("mine", "./SKILL.md"),
      (err: unknown) => err instanceof store.SkillError && err.code === "invalid_path",
      "AC-7b FAIL: ./SKILL.md 归一化后仍应拒删",
    );
    await assert.rejects(
      () => store.deleteSkillFile("mine", "scripts/../SKILL.md"),
      (err: unknown) => err instanceof store.SkillError && err.code === "invalid_path",
      "AC-7b FAIL: scripts/../SKILL.md 归一化后仍应拒删",
    );
    assert.ok(existsSync(path.join(userRoot, "skills", "mine", "SKILL.md")), "AC-7b FAIL: SKILL.md 不应被上述任一尝试删除");

    // ── AC-8: 路径穿越必须被拒(读/写都拒) ──────────────────────────────
    await assert.rejects(
      () => store.readSkillFile("mine", "../../../../etc/passwd"),
      (err: unknown) => err instanceof store.SkillError && err.code === "invalid_path",
      "AC-8 FAIL: 读穿越路径应拒",
    );
    await assert.rejects(
      () => store.writeSkillFile("mine", "../escape.txt", "x"),
      (err: unknown) => err instanceof store.SkillError && err.code === "invalid_path",
      "AC-8 FAIL: 写穿越路径应拒",
    );

    // ── AC-9: 删除纯用户技能 ───────────────────────────────────────────
    await store.deleteSkill("mine");
    assert.equal(await store.getSkill("mine"), null, "AC-9 FAIL: 用户技能应被删除");

    // ── AC-10: 名称校验 ────────────────────────────────────────────────
    assert.equal(store.isValidSkillName("../evil"), false);
    assert.equal(store.isValidSkillName("good-name1"), true);

    // ── AC-11: 路由层——GET /api/skills 返回 title/summary;PATCH 对内置改 enabled 拒 403 ──
    const skillsRoute = await import("../app/api/skills/route.ts");
    const listRes = await skillsRoute.GET(new Request("http://local/api/skills"));
    const listBody = (await listRes.json()) as { ok: boolean; data: { name: string; title: string; summary: string }[] };
    assert.equal(listBody.ok, true);
    const demoItem = listBody.data.find((s) => s.name === "demo");
    assert.equal(demoItem?.title, "演示技能", "AC-11 FAIL: /api/skills 应返回 title");
    assert.equal(demoItem?.summary, "一句给财务用户看的演示说明。", "AC-11 FAIL: /api/skills 应返回 summary");

    const nameRoute = await import("../app/api/skills/[name]/route.ts");
    const patchRes = await nameRoute.PATCH(
      new Request("http://local/api/skills/demo", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ name: "demo" }) },
    );
    assert.equal(patchRes.status, 403, "AC-11 FAIL: PATCH 停用内置技能应拒 403");
    assert.equal((await store.getSkill("demo"))?.enabled, true, "AC-11 FAIL: 内置技能 PATCH 后应仍启用");

    console.log("skills-store: 内置只读恒启用/用户全改可启停/title 展示字段/文件操作/路径防穿越/SDK 配置 ✓");
  } finally {
    delete process.env.FINANCE_AGENT_BUNDLED_PLUGIN_DIR;
    delete process.env.FINANCE_AGENT_USER_PLUGIN_DIR;
    delete process.env.FINANCE_AGENT_SKILLS_STATE_PATH;
    rmSync(fixture, { recursive: true, force: true });
  }
})();
