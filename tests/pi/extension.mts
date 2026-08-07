import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFinworkBuiltinTools,
  type FinworkBuiltinRoots,
} from "../../lib/agent/pi/builtin-tools.ts";
import { evaluateBuiltinToolCall } from "../../lib/agent/pi/extension.ts";
import { isBashSandboxAvailable } from "../../lib/agent/tools/bash-sandbox.ts";

const root = mkdtempSync(path.join(tmpdir(), "finwork-pi-extension-"));
const filesDir = path.join(root, "files", "42");
const outputDir = path.join(filesDir, "generate");
const deliveredDir = path.join(filesDir, "delivered");
mkdirSync(outputDir, { recursive: true });
mkdirSync(deliveredDir, { recursive: true });

const roots: FinworkBuiltinRoots = { writeRoot: outputDir, readRoot: filesDir };

// ── L1-1 工具构造：真实构造 pi 内置工具（不是名字清单），确认名字与 schema 形状 ──
// bash 的唯一边界是 OS 沙箱（builtin-tools.ts fail-closed 设计：拿不到沙箱就不注册），
// 而沙箱当前只有 macOS 的 sandbox-exec 实现——CI 的 Linux runner 上 bash 本就不该出现,
// 断言必须跟着 isBashSandboxAvailable() 走,不能假定所有平台都有 bash。
const tools = await createFinworkBuiltinTools(roots);
const expectedNames = ["edit", "find", "grep", "ls", "read", "write"];
if (isBashSandboxAvailable()) expectedNames.push("bash");
assert.deepEqual(
  tools.map((tool) => tool.name).sort(),
  expectedNames.sort(),
  "L1-1 FAIL: 应注册 pi 的 read/grep/find/ls/write/edit（有沙箱时还有 bash，小写名）",
);
// 闸依赖入参形状：pi 用 `path`（不是 Claude 时代的 `file_path`）。形状漂移必须让测试红。
for (const name of ["read", "write", "edit"]) {
  const schema = tools.find((tool) => tool.name === name)!.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.ok(schema.properties?.path, `L1-1 FAIL: ${name} 的入参应有 path 字段`);
}
if (isBashSandboxAvailable()) {
  assert.ok(
    (tools.find((tool) => tool.name === "bash")!.parameters as { properties?: Record<string, unknown> })
      .properties?.command,
    "L1-1 FAIL: bash 的入参应有 command 字段",
  );
}

// ── L1-2 写类工具：outputDir 之内放行，之外拒绝 ──
assert.equal(
  evaluateBuiltinToolCall("write", { path: path.join(outputDir, "report.md") }, roots),
  null,
  "L1-2 FAIL: 写入会话输出目录应放行",
);
assert.equal(
  evaluateBuiltinToolCall("write", { path: "report.md" }, roots),
  null,
  "L1-2 FAIL: Pi cwd 下的相对写入路径应按会话输出目录解析",
);
assert.equal(
  evaluateBuiltinToolCall("edit", { path: "scripts/build.py" }, roots),
  null,
  "L1-2 FAIL: Pi cwd 下的相对编辑路径应按会话输出目录解析",
);
assert.match(
  evaluateBuiltinToolCall("write", { path: "/etc/crontab" }, roots) ?? "",
  /只能把生成文件写入/,
  "L1-2 FAIL: 越界绝对路径写入必须拒绝",
);
assert.match(
  evaluateBuiltinToolCall("edit", { path: path.join(root, "..", "escape.md") }, roots) ?? "",
  /只能把生成文件写入/,
  "L1-2 FAIL: 用 .. 逃逸的相对路径必须拒绝",
);

// ── L1-3 delivered/ 不可变区：正式交付物只读 ──
assert.match(
  evaluateBuiltinToolCall("write", { path: path.join(deliveredDir, "invoice.xlsx") }, roots) ?? "",
  /不可变交付目录/,
  "L1-3 FAIL: delivered/ 必须拒绝写入",
);

// ── L1-4 read 比 write 宽一级：能读同会话上传的附件，但不能读会话目录之外 ──
assert.equal(
  evaluateBuiltinToolCall("read", { path: path.join(filesDir, "uploaded.xlsx") }, roots),
  null,
  "L1-4 FAIL: 应能读取本会话上传的附件",
);
assert.equal(
  evaluateBuiltinToolCall("read", { path: "generate/report.md" }, roots),
  null,
  "L1-4 FAIL: 相对读取路径应按会话读取根解析",
);
assert.match(
  evaluateBuiltinToolCall("read", { path: "/Users/someone/.ssh/id_rsa" }, roots) ?? "",
  /只能读取本次会话/,
  "L1-4 FAIL: 会话目录之外的读取必须拒绝",
);

// ── L1-5 bash：明显破坏性命令拒绝，普通命令放行 ──
assert.equal(
  evaluateBuiltinToolCall("bash", { command: "ls -la && wc -l report.md" }, roots),
  null,
  "L1-5 FAIL: 普通命令应放行",
);
for (const command of ["sudo rm -rf /", "rm -rf ~/Documents", "rm -rf /"]) {
  assert.match(
    evaluateBuiltinToolCall("bash", { command }, roots) ?? "",
    /破坏性/,
    `L1-5 FAIL: 破坏性命令应拒绝：${command}`,
  );
}
for (const command of ["find / -name '新建 XLSX*'", "find /Users/gyro -name '*.xlsx'", "find ~ -name '*.xlsx'"]) {
  assert.match(
    evaluateBuiltinToolCall("bash", { command }, roots) ?? "",
    /全盘路径探查/,
    `L1-5b FAIL: 应拒绝全盘探查: ${command}`,
  );
}

// ── L1-6 非内置工具不受本闸影响（财务工具的授权仍在 tool-adapter 的 Zod 之后）──
assert.equal(
  evaluateBuiltinToolCall("read_document", { filePath: "/etc/passwd" }, roots),
  null,
  "L1-6 FAIL: 财务工具不应被内置工具闸处理",
);

// ── L1-7 缺失/非法 path 不放过（防止靠省略参数绕闸）──
assert.match(
  evaluateBuiltinToolCall("write", {}, roots) ?? "",
  /缺少 path/,
  "L1-7 FAIL: 写类工具缺少 path 必须拒绝",
);

// ── L1-8 接线验证：扩展必须真的被 ResourceLoader 加载并注册了 tool_call handler ──
// 纯函数绿 ≠ 闸生效。这里走真实 loader（noExtensions: true 仍开着，验证内联工厂不受它压制），
// 再直接调用注册进去的 handler，确认拦截真的从 Pi 侧发生。
{
  const { createFinworkPiResourceLoader } = await import("../../lib/agent/pi/resource-loader.ts");
  const { createFinworkExtension } = await import("../../lib/agent/pi/extension.ts");
  const blocked: string[] = [];
  const loader = await createFinworkPiResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    systemPrompt: "L1 wiring probe",
    extensionFactories: [
      createFinworkExtension({
        roots,
        emit: (event) => {
          if (event.type === "run_blocked") blocked.push(event.toolName ?? "");
        },
      }),
    ],
  });

  const extensions = loader.getExtensions().extensions;
  const finwork = extensions.find((extension) => extension.path.includes("finwork-core"));
  assert.ok(
    finwork,
    `L1-8 FAIL: finwork-core 未被加载（noExtensions 压制了内联工厂？）实际：${extensions.map((e) => e.path).join(", ")}`,
  );
  const handlers = finwork.handlers.get("tool_call") ?? [];
  assert.equal(handlers.length, 1, "L1-8 FAIL: 应注册恰好一个 tool_call handler");

  const deny = await handlers[0](
    { toolName: "write", toolCallId: "probe-1", input: { path: "/etc/crontab" } },
    {} as never,
  );
  assert.deepEqual(
    { block: (deny as { block?: boolean })?.block, blocked },
    { block: true, blocked: ["write"] },
    "L1-8 FAIL: 经 Pi 注册的 handler 应拦截越界写入并发 run_blocked",
  );

  const allow = await handlers[0](
    { toolName: "write", toolCallId: "probe-2", input: { path: path.join(outputDir, "ok.md") } },
    {} as never,
  );
  assert.equal(allow, undefined, "L1-8 FAIL: 目录内写入应放行");
}

// ── L4-1 技能目录只读放行：渐进披露的前提 ──
// 此前技能正文与其 references/scripts 全被闸拒，SKILL.md 让模型去看的文件根本读不到。
{
  const skillRoot = path.join(root, "agent-skills", "skills");
  const withSkills = { ...roots, skillRoots: [skillRoot] };
  for (const rel of ["xlsx/SKILL.md", "xlsx/scripts/recalc.py", "pdf/reference.md"]) {
    assert.equal(
      evaluateBuiltinToolCall("read", { path: path.join(skillRoot, rel) }, withSkills),
      null,
      `L4-1 FAIL: 技能文件应可读：${rel}`,
    );
  }
  // 未声明 skillRoots 时仍然拒绝（放行是显式的，不是默认的）
  assert.match(
    evaluateBuiltinToolCall("read", { path: path.join(skillRoot, "xlsx/SKILL.md") }, roots) ?? "",
    /只能读取/,
    "L4-1 FAIL: 未声明 skillRoots 不应放行",
  );
  // 技能目录只读——不能往里写
  assert.match(
    evaluateBuiltinToolCall("write", { path: path.join(skillRoot, "evil.md") }, withSkills) ?? "",
    /只能把生成文件写入/,
    "L4-1 FAIL: 技能目录必须只读",
  );
}

// ── L4-2 grep/find/ls 与 read 同级受闸，且 path 可省略 ──
{
  const skillRoot = path.join(root, "agent-skills", "skills");
  const withSkills = { ...roots, skillRoots: [skillRoot] };
  for (const tool of ["grep", "find", "ls"]) {
    assert.equal(
      evaluateBuiltinToolCall(tool, {}, withSkills),
      null,
      `L4-2 FAIL: ${tool} 省略 path 应放行（落在构造时的会话 cwd）`,
    );
    assert.equal(
      evaluateBuiltinToolCall(tool, { path: outputDir }, withSkills),
      null,
      `L4-2 FAIL: ${tool} 在会话目录内应放行`,
    );
    assert.match(
      evaluateBuiltinToolCall(tool, { path: "/etc" }, withSkills) ?? "",
      /只能读取/,
      `L4-2 FAIL: ${tool} 越界必须拒绝`,
    );
  }
  // read 省略 path 仍必须拒绝——它没有有意义的缺省，省略即无从校验
  assert.match(
    evaluateBuiltinToolCall("read", {}, withSkills) ?? "",
    /缺少 path/,
    "L4-2 FAIL: read 省略 path 应拒绝",
  );
}

console.log("Pi extension ✓ builtin tools rooted at Finwork dirs, path/bash gate wired via Pi tool_call");
