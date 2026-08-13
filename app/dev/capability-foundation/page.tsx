import { notFound } from "next/navigation";

import { Surface } from "@/components/ui/surface";
import { getDb } from "@/lib/db/sqlite";
import { captureFoundationDiagnostics } from "@/lib/observability/foundation-diagnostics";

export const dynamic = "force-dynamic";

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-caption text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function CapabilityFoundationDiagnosticsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const snapshot = captureFoundationDiagnostics(getDb());
  return (
    <main className="min-h-dvh overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4 px-6 py-8">
        <div>
          <h1 className="text-h1">能力基础设施诊断</h1>
          <p className="mt-1 text-body text-muted-foreground">仅开发环境可访问；仅包含聚合计数、哈希结果和运行状态。</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(snapshot).filter(([key]) => !["snapshotId", "capturedAt"].includes(key)).map(([key, value]) => (
            <Surface key={key} level="card" edge="hairline" shape="panel" pad="card" className="min-w-0">
              <h2 className="mb-2 text-title font-medium">{key}</h2>
              <JsonBlock value={value} />
            </Surface>
          ))}
        </div>
      </div>
    </main>
  );
}
