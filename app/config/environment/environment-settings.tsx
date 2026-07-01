"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type DoctorStatus = { ok: boolean; detail: string; pythonVersion?: string; missing?: string[] };

/** 「运行环境」卡片正文:高级分析组件(Python)检测与一键安装。标题/说明由外层 SettingsCard 提供。 */
export function RuntimeEnvBody() {
  const [status, setStatus] = useState<DoctorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/doctor");
      const body = await res.json();
      setStatus(body?.data?.python ?? null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function enableAdvanced() {
    setInstalling(true);
    setInstallMsg("正在下载并安装高级分析组件，这可能需要几分钟…");
    try {
      const res = await fetch("/api/settings/python/install", { method: "POST" });
      const body = await res.json();
      setInstallMsg(body?.data?.detail ?? (body?.ok ? "已启用。" : "安装失败，请稍后重试。"));
      await refresh();
    } catch {
      setInstallMsg("安装请求失败，请检查网络后重试。基础功能不受影响。");
    } finally {
      setInstalling(false);
    }
  }

  const ready = status?.ok === true;

  return (
    <>
      <div className="text-body">
        <span className="font-medium">高级分析组件：</span>
        {loading ? (
          <span className="text-muted-foreground">检测中…</span>
        ) : (
          <span className="text-muted-foreground">
            {ready ? "✅ 已就绪" : "⚠ 未启用"}
            {status?.detail ? ` — ${status.detail}` : ""}
          </span>
        )}
      </div>

      {!ready && !loading && (
        <div className="flex flex-col gap-2">
          <Button onClick={enableAdvanced} disabled={installing} className="w-fit">
            {installing ? "安装中…" : "启用高级 Excel / PDF 分析"}
          </Button>
          <p className="text-meta text-muted-foreground">
            安装包将下载到本应用的数据目录，无需管理员权限，不影响系统其它软件。未启用时，基础财务功能照常可用。
          </p>
        </div>
      )}

      {installMsg && <p className="text-body text-muted-foreground">{installMsg}</p>}
    </>
  );
}
