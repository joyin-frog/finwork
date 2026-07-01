import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// 技能数据层 CRUD + 文件操作行为测试(新模型)。用临时目录 + 环境变量隔离,真实读写文件:
// - 内置技能只读(可启停,不可改/删/改文件);用户技能全可改(描述/正文/任意文件)。
// - 名字内置/用户互斥;喂给 SDK 的 plugins/skills 计算;路径穿越必须被拒。
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
  writeFileSync(path.join(demoDir, "SKILL.md"), `---\nname: demo\ndescription: 内置演示技能\n---\n\n# Demo\n正文。\n`);
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

    // ── AC-6: 启停(内置/用户都可);停用从 SDK 白名单剔除 ──────────────
    await store.setSkillEnabled("demo", false);
    list = await store.listSkills();
    assert.equal(list.find((s) => s.name === "demo")?.enabled, false);
    cfg = await store.getSkillSdkConfig();
    assert.ok(Array.isArray(cfg.skills), "AC-6 FAIL: 有用户技能/停用时 skills 应为白名单数组");
    const skills = cfg.skills as string[];
    assert.equal(cfg.plugins.length, 2, "AC-6 FAIL: 应注册内置+用户两个 plugin");
    assert.ok(skills.includes("user-skills:mine"), "AC-6 FAIL: 用户技能应在白名单");
    assert.ok(!skills.some((s) => s.endsWith(":demo")), "AC-6 FAIL: 停用的 demo 应被剔除");
    await store.setSkillEnabled("demo", true);

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

    console.log("skills-store: 内置只读/用户全改/文件操作/路径防穿越/SDK 配置 ✓");
  } finally {
    delete process.env.FINANCE_AGENT_BUNDLED_PLUGIN_DIR;
    delete process.env.FINANCE_AGENT_USER_PLUGIN_DIR;
    delete process.env.FINANCE_AGENT_SKILLS_STATE_PATH;
    rmSync(fixture, { recursive: true, force: true });
  }
})();
