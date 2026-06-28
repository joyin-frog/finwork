"use client";

/**
 * /e2e-preview — 仅供 e2e 截图测试使用的最小 harness。
 * URL 参数 ?fixture=xxx (文件名,如 excel-preview-enhance.xlsx) 触发从 /api/test-fixtures
 * 加载文件,以 DraftPreviewFile 形式喂给 FilePreviewPage,绕过 Tauri 文件对话框。
 * 生产打包不影响:Tauri 沙箱没有 tests/fixtures,API 404 就好。
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { FilePreviewPage, type DraftPreviewFile } from "@/app/shared/file-preview-page";

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
