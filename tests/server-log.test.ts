import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const serverLogTestPromise = (async () => {
  const appData = mkdtempSync(path.join(tmpdir(), "fa-serverlog-"));
  const orig = process.env.FINANCE_AGENT_APP_DATA_DIR;
  process.env.FINANCE_AGENT_APP_DATA_DIR = appData;
  try {
    const { formatServerError, logServerError } = await import("../lib/runtime/server-log.ts");

    // ── 纯函数:digest / 路径 / 堆栈都进文本 ──
    const err = Object.assign(new Error("boom"), { digest: "97837100" });
    const line = formatServerError(err, { path: "/config", method: "GET", extra: "app-router render" });
    assert.ok(line.includes("digest=97837100"), "应包含 digest(对应用户看到的那串)");
    assert.ok(line.includes("GET /config"), "应包含请求方法+路径");
    assert.ok(line.includes("boom"), "应包含错误堆栈/消息");
    assert.ok(line.includes("app-router render"), "应包含上下文");

    // 非 Error 入参也不崩
    assert.ok(formatServerError("plain string fail").includes("plain string fail"));

    // ── 落盘:写到 <appData>/logs/server-<date>.log ──
    await logServerError(err, { path: "/config", method: "GET" });
    const logsDir = path.join(appData, "logs");
    const files = readdirSync(logsDir).filter((f) => f.startsWith("server-") && f.endsWith(".log"));
    assert.equal(files.length, 1, "应生成当日日志文件");
    const content = readFileSync(path.join(logsDir, files[0]), "utf-8");
    assert.ok(content.includes("digest=97837100") && content.includes("/config"), "日志文件应含 digest 与路径");

    console.log("server-log: all checks passed ✓");
  } finally {
    if (orig === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = orig;
    rmSync(appData, { recursive: true, force: true });
  }
})();
