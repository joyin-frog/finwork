import assert from "node:assert/strict";
import { buildFileTree, filterSkills, fileLang } from "../app/skills/file-tree.ts";

// /skills 编辑器的纯逻辑单测:扁平文件路径 → 折叠文件树 + 技能搜索过滤。
export const skillsFileTreeTestPromise = (async () => {
  // ── buildFileTree ──────────────────────────────────────────────────
  // AC-1: 平铺文件(无目录)
  let tree = buildFileTree([{ path: "SKILL.md", isDir: false }]);
  assert.equal(tree.length, 1);
  assert.deepEqual({ name: tree[0].name, path: tree[0].path, isDir: tree[0].isDir, kids: tree[0].children.length }, { name: "SKILL.md", path: "SKILL.md", isDir: false, kids: 0 });

  // AC-2: 嵌套 + 目录在前、同类字母序
  tree = buildFileTree([
    { path: "SKILL.md", isDir: false },
    { path: "scripts", isDir: true },
    { path: "scripts/run.py", isDir: false },
    { path: "scripts/a.py", isDir: false },
  ]);
  assert.deepEqual(tree.map((n) => n.name), ["scripts", "SKILL.md"], "AC-2 FAIL: 目录应排在文件前");
  const scripts = tree[0];
  assert.equal(scripts.isDir, true);
  assert.deepEqual(scripts.children.map((n) => n.name), ["a.py", "run.py"], "AC-2 FAIL: 同级文件应按字母序");
  assert.equal(scripts.children[0].path, "scripts/a.py", "AC-2 FAIL: 子节点 path 应为完整相对路径");

  // AC-3: 深层嵌套自动补出中间目录(即使扁平列表里没有显式列出 office)
  tree = buildFileTree([{ path: "scripts/office/schemas/foo.xsd", isDir: false }]);
  const office = tree[0].children[0];
  assert.equal(tree[0].name, "scripts");
  assert.equal(office.name, "office");
  assert.equal(office.isDir, true, "AC-3 FAIL: 中间目录应被推断为目录");
  assert.equal(office.children[0].children[0].name, "foo.xsd");

  // AC-4: 显式目录条目与作为前缀的隐式目录去重(不产生两个 scripts)
  tree = buildFileTree([
    { path: "scripts", isDir: true },
    { path: "scripts/run.py", isDir: false },
  ]);
  assert.equal(tree.filter((n) => n.name === "scripts").length, 1, "AC-4 FAIL: 目录不应重复");

  // ── filterSkills ───────────────────────────────────────────────────
  const skills = [
    { name: "pdf", description: "处理 PDF 文件" },
    { name: "finance-analysis", description: "财务数据分析与汇总" },
  ];
  assert.equal(filterSkills(skills, "").length, 2, "空查询返回全部");
  assert.deepEqual(filterSkills(skills, "PDF").map((s) => s.name), ["pdf"], "按名(忽略大小写)");
  assert.deepEqual(filterSkills(skills, "汇总").map((s) => s.name), ["finance-analysis"], "按描述命中");
  assert.equal(filterSkills(skills, "xxxnope").length, 0, "无命中返回空");

  // ── fileLang:扩展名 → 高亮语言(供"代码块渲染") ──────────────────
  assert.equal(fileLang("scripts/run.py"), "python", "py → python");
  assert.equal(fileLang("a.JS"), "javascript", "忽略大小写");
  assert.equal(fileLang("data.json"), "json");
  assert.equal(fileLang("SKILL.md"), "markdown", "md 也算可渲染");
  assert.equal(fileLang("noext"), null, "无扩展名 → null");
  assert.equal(fileLang("weird.xyz"), null, "未知扩展名 → null");

  console.log("skills-file-tree: buildFileTree + filterSkills + fileLang ✓");
})();
