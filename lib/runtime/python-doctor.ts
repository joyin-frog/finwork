import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { getProjectRoot, getPythonPath } from "./paths";

export type PythonDoctorResult = {
  ok: boolean;
  pythonPath: string;
  /** 面向用户的人话状态(不出现 token/模型等技术黑话) */
  detail: string;
  pythonVersion?: string;
  deps?: Record<string, string>;
  missing?: string[];
};

/** 解析 worker --selfcheck 的 JSON 输出(纯函数,便于单测)。 */
export function interpretSelfcheck(raw: string, pythonPath: string): PythonDoctorResult {
  let parsed: { python?: string; deps?: Record<string, string>; missing?: string[]; ok?: boolean };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, pythonPath, detail: "无法解析 Python 自检结果，环境可能异常。" };
  }
  const missing = parsed.missing ?? [];
  if (missing.length > 0) {
    return {
      ok: false,
      pythonPath,
      pythonVersion: parsed.python,
      deps: parsed.deps,
      missing,
      detail: `缺少处理 Excel/PDF 所需的组件：${missing.join("、")}。请重新安装应用或联系支持。`
    };
  }
  return {
    ok: true,
    pythonPath,
    pythonVersion: parsed.python,
    deps: parsed.deps,
    missing: [],
    detail: `Python 环境就绪（版本 ${parsed.python ?? "未知"}）。`
  };
}

type Runner = (pythonPath: string, args: string[]) => Promise<string>;

/** 运行真实自检:定位 Python → 跑 --selfcheck → 解析。失败一律降级为人话提示。 */
export async function checkPythonEnvironment(opts?: { runner?: Runner; exists?: (p: string) => boolean }): Promise<PythonDoctorResult> {
  const pythonPath = getPythonPath();
  const exists = opts?.exists ?? fs.existsSync;
  if (!exists(pythonPath)) {
    return {
      ok: false,
      pythonPath,
      detail: "未找到 Python 运行时：复杂 Excel / PDF 处理将不可用。请确认应用已正确安装。"
    };
  }
  const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
  const runner = opts?.runner ?? defaultRunner;
  try {
    const stdout = await runner(pythonPath, [workerPath, "--selfcheck"]);
    return interpretSelfcheck(stdout, pythonPath);
  } catch (error) {
    return {
      ok: false,
      pythonPath,
      detail: `Python 自检失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function defaultRunner(pythonPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(pythonPath, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}
