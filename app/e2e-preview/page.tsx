"use client";

/**
 * /e2e-preview — 仅供 e2e 截图测试使用的最小 harness。
 * URL 参数 ?fixture=xxx (文件名,如 excel-preview-enhance.xlsx) 触发从 /api/test-fixtures
 * 加载文件,以 DraftPreviewFile 形式喂给 FilePreviewPage,绕过 Tauri 文件对话框。
 * 生产打包不影响:Tauri 沙箱没有 tests/fixtures,API 404 就好。
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { WorkspaceChangeCard, type WorkspaceChangeCardData } from "@/app/components/workspace-change-card";
import { FilePreviewPage, type DraftPreviewFile } from "@/app/shared/file-preview-page";

const workspaceChangeFixtures: WorkspaceChangeCardData[] = [
  {
    changesetId: "e2e-working",
    candidateVersionId: "e2e-working-version",
    candidateName: "一季度经营分析_第2轮.xlsx",
    iteration: 2,
    readyForUser: false,
    diff: {
      kind: "xlsx",
      summary: "修改 4 个单元格，新增 1 个公式",
      details: {
        cellChanges: {
          changed: [
            { address: "经营分析!F12", before: { value: 1280000 }, after: { value: 1460000 } },
            { address: "经营分析!F18", before: { formula: "SUM(F13:F17)", value: 920000 }, after: { formula: "SUM(F13:F17)", value: 1010000 } },
          ],
        },
      },
    },
    plan: {
      complete: false,
      completed: [
        { address: "经营分析!F12", description: "更新一季度营业收入" },
        { address: "经营分析!F18", description: "修正费用合计公式" },
      ],
      pending: [
        { address: "风险提示!B6", description: "补充扩张亏损风险", reason: "缺少现金流覆盖月数" },
      ],
    },
    script: {
      name: "revise_q1_report.py",
      versionId: "e2e-script-working",
      diff: {
        summary: "调整 2 行",
        details: {
          changedLines: [
            { line: 18, before: "revenue = q1[\"revenue\"]", after: "revenue = normalize_amount(q1[\"revenue\"])" },
            { line: 41, before: null, after: "ws[\"F18\"] = \"=SUM(F13:F17)\"" },
          ],
        },
      },
    },
  },
  {
    changesetId: "e2e-ready",
    candidateVersionId: "e2e-ready-version",
    candidateName: "一季度经营分析_交付版.xlsx",
    iteration: 3,
    complete: true,
    readyForUser: false,
    diff: {
      kind: "xlsx",
      summary: "修改 6 个单元格，新增 2 个公式",
      details: {
        cellChanges: {
          changed: [
            { address: "经营分析!F12", before: { value: 1280000 }, after: { value: 1460000 } },
            { address: "风险提示!B6", before: { value: "" }, after: { value: "扩张速度高于现金流增速，建议关注未来 3 个月资金覆盖。" } },
          ],
        },
      },
    },
    plan: {
      complete: true,
      completed: [
        { address: "经营分析!F12", description: "更新一季度营业收入" },
        { address: "经营分析!F18", description: "修正费用合计公式" },
        { address: "风险提示!B6", description: "补充扩张亏损风险" },
      ],
      pending: [],
    },
    script: {
      name: "revise_q1_report.py",
      versionId: "e2e-script-ready",
      diff: {
        summary: "第 3 轮调整 1 行",
        details: {
          changedLines: [
            { line: 52, before: "coverage_months = 2", after: "coverage_months = cash / monthly_burn" },
          ],
        },
      },
    },
  },
];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function E2EPreviewInner() {
  const params = useSearchParams();
  const fixture = params.get("fixture");
  const workspaceChange = params.get("workspace-change");
  const [selection, setSelection] = useState<DraftPreviewFile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!fixture) return;
    fetch(`/api/test-fixtures?name=${encodeURIComponent(fixture)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
        const ab = await res.arrayBuffer();
        const b64 = arrayBufferToBase64(ab);
        const ext = fixture.split(".").pop()?.toLowerCase() ?? "bin";
        const mimeMap: Record<string, string> = {
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          csv: "text/csv",
        };
        const mime = mimeMap[ext] ?? "application/octet-stream";
        setSelection({
          kind: "draft",
          name: fixture,
          mimeType: mime,
          sizeBytes: ab.byteLength,
          dataUrl: `data:${mime};base64,${b64}`,
        });
      })
      .catch((e) => setLoadErr(String(e)));
  }, [fixture]);

  if (workspaceChange) {
    return (
      <main className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
          {workspaceChangeFixtures.map((data) => (
            <WorkspaceChangeCard key={data.changesetId} data={data} />
          ))}
        </div>
      </main>
    );
  }

  if (!fixture) {
    return <div style={{ padding: 24 }}>请提供 ?fixture=文件名 参数</div>;
  }
  if (loadErr) {
    return <div style={{ padding: 24, color: "red" }}>fixture 加载失败: {loadErr}</div>;
  }

  return (
    <section style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <FilePreviewPage
        selection={selection}
        title="e2e 截图测试预览"
        description="正在加载 fixture..."
      />
    </section>
  );
}

export default function E2EPreviewPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>加载中...</div>}>
      <E2EPreviewInner />
    </Suspense>
  );
}
