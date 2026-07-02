import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createScanSlipFolderTool } from "../lib/agent/mcp-tools/scan-slip-folder.ts";

// scan_slip_folder:真实目录结构 → 分组(子文件夹一组 + 根散文件各一组),返回绝对路径。
export const scanSlipFolderTestPromise = (async () => {
  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = { tool: (n: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => { handlers.set(n, h); return { name: n }; } };
  createScanSlipFolderTool(mockSdk);
  const scan = handlers.get("scan_slip_folder")!;

  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-scan-"));
  try {
    // 子文件夹一笔:付款单 + 发票 + 回单
    mkdirSync(path.join(dir, "0601-付杰强"));
    writeFileSync(path.join(dir, "0601-付杰强", "付款单.jpg"), "x");
    writeFileSync(path.join(dir, "0601-付杰强", "发票.pdf"), "x");
    writeFileSync(path.join(dir, "0601-付杰强", "回单.pdf"), "x");
    // 根目录多页PDF + 散图 各自一组
    writeFileSync(path.join(dir, "水电费.pdf"), "x");
    writeFileSync(path.join(dir, "报销单.jpg"), "x");
    // 干扰:系统文件
    writeFileSync(path.join(dir, ".DS_Store"), "x");

    const res = (await scan({ folderPath: dir })) as {
      structuredContent: { groups: Array<{ group: string; files: string[] }>; groupCount: number };
    };
    assert.equal(res.structuredContent.groupCount, 3, "S1 FAIL: 应 3 组(付杰强+水电费+报销单)");
    const g = res.structuredContent.groups.find((x) => x.group === "0601-付杰强");
    assert.ok(g && g.files.length === 3, "S2 FAIL: 子文件夹组含 3 文件");
    assert.ok(g!.files.every((f) => path.isAbsolute(f)), "S3 FAIL: 返回绝对路径(供 read_document)");
    assert.ok(res.structuredContent.groups.some((x) => x.group === "水电费.pdf"), "S4 FAIL: 多页PDF自成一组");

    // 不存在的目录 → 报错
    const bad = (await scan({ folderPath: "/tmp/nope-scan-98765" })) as { isError?: boolean };
    assert.equal(bad.isError, true, "S5 FAIL: 目录不存在应报错");

    console.log("scan-slip-folder: 子文件夹/多页PDF/散图分组 · 绝对路径 · 过滤系统文件 · 错误处理 ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
