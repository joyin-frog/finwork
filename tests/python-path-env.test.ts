/**
 * Tests for getPythonBinDir / getPythonVenvRoot — 保证 skill 经 Bash 跑的 python 命中
 * getPythonPath() 同一解释器,且只有真 venv 才设 VIRTUAL_ENV。
 * Run: node --import tsx tests/python-path-env.test.ts
 */
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export const pythonPathEnvTestPromise = (async () => {
  const saved = process.env.FINANCE_AGENT_PYTHON_PATH;
  const paths = await import("../lib/runtime/paths.ts");
  try {
    // ① getPythonBinDir 必须 = dirname(getPythonPath):前置进 PATH 后 Bash 的 python 命中同一解释器
    const fakeExe = path.join(os.tmpdir(), "fa-pyenv-test", "bin", "python3");
    process.env.FINANCE_AGENT_PYTHON_PATH = fakeExe;
    assert.equal(paths.getPythonPath(), fakeExe, "getPythonPath 应取 FINANCE_AGENT_PYTHON_PATH");
    assert.equal(
      paths.getPythonBinDir(),
      path.dirname(fakeExe),
      "getPythonBinDir 应 = dirname(getPythonPath)(skill 经 Bash 命中同一 bin)"
    );

    // ② getPythonVenvRoot:只有存在 pyvenv.cfg 才认定为 venv
    const venvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fa-pyenv-venv-"));
    fs.mkdirSync(path.join(venvRoot, "bin"), { recursive: true });
    process.env.FINANCE_AGENT_PYTHON_PATH = path.join(venvRoot, "bin", "python3");
    assert.equal(paths.getPythonVenvRoot(), null, "无 pyvenv.cfg → 非 venv(standalone)→ null");
    fs.writeFileSync(path.join(venvRoot, "pyvenv.cfg"), "home = /x\n");
    assert.equal(paths.getPythonVenvRoot(), venvRoot, "有 pyvenv.cfg → 返回 venv 根(供 VIRTUAL_ENV)");
    fs.rmSync(venvRoot, { recursive: true, force: true });

    console.log("✓ python-path-env");
  } finally {
    if (saved === undefined) delete process.env.FINANCE_AGENT_PYTHON_PATH;
    else process.env.FINANCE_AGENT_PYTHON_PATH = saved;
  }
})();
