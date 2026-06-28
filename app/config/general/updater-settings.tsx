"use client";

/**
 * 自动更新 UI(Tauri updater 插件)。
 * 人工审核门:发现新版本后必须用户确认才下载安装。
 *
 * 只在 Tauri 桌面壳内工作;Web 模式(Next.js dev / 浏览器)下静默隐藏。
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/app/config/settings-ui";

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "no-update" }
  | { state: "available"; version: string; notes: string | null }
  | { state: "downloading"; progress: number }
  | { state: "installing" }
  | { state: "error"; message: string };

/** 检测是否在 Tauri 壳内。 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 把底层错误翻成可操作提示。更新通道要真正可用,需先完成发布签名配置
 * (见 docs/updater-signing.md);本地/未配置环境下 check() 会失败,属预期。
 */
function friendlyUpdaterError(err: unknown): string {
  const m = String(err);
  if (/Cannot find module|plugin-updater/i.test(m)) {
    return "更新依赖未安装。请在项目根目录跑 npm install 后重启应用。";
  }
  if (/pubkey|public key|signature|verify/i.test(m)) {
    return "更新通道未配置签名公钥。需先 `npm run tauri signer generate` 并把公钥填进 tauri.conf.json(详见 docs/updater-signing.md)。";
  }
  if (/fetch|network|endpoint|404|could not|resolve|json|parse/i.test(m)) {
    return "未找到可用更新源:release 发布地址尚未配置,或当前已是最新、暂无 latest.json(详见 docs/updater-signing.md)。";
  }
  return m;
}

export function UpdaterSettings() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [pendingUpdate, setPendingUpdate] = useState<{
    version: string;
    notes: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: any; // tauri-plugin-updater Update 对象
  } | null>(null);

  if (!isTauri()) return null;

  async function checkUpdate() {
    setStatus({ state: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setStatus({ state: "no-update" });
        return;
      }
      setPendingUpdate({
        version: update.version,
        notes: update.body ?? null,
        update,
      });
      setStatus({ state: "available", version: update.version, notes: update.body ?? null });
    } catch (err) {
      setStatus({ state: "error", message: friendlyUpdaterError(err) });
    }
  }

  /** 用户确认后才下载安装(人工审核门)。 */
  async function confirmAndInstall() {
    if (!pendingUpdate) return;
    const { update } = pendingUpdate;
    try {
      setStatus({ state: "downloading", progress: 0 });
      let downloaded = 0;
      let total = 1;
      await update.downloadAndInstall((event: { event: string; data?: { chunkLength?: number; contentLength?: number } }) => {
        if (event.event === "Started") {
          total = event.data?.contentLength ?? 1;
        } else if (event.event === "Progress") {
          downloaded += event.data?.chunkLength ?? 0;
          setStatus({ state: "downloading", progress: Math.round((downloaded / total) * 100) });
        } else if (event.event === "Finished") {
          setStatus({ state: "installing" });
        }
      });
    } catch (err) {
      setStatus({ state: "error", message: friendlyUpdaterError(err) });
    }
  }

  function cancelUpdate() {
    setPendingUpdate(null);
    setStatus({ state: "idle" });
  }

  return (
    <SettingsSection
      title="应用更新"
      description="检查是否有新版本可用。发现新版本时须手动确认后才会下载安装。"
    >
      {status.state === "idle" && (
        <Button variant="outline" className="w-fit" onClick={() => void checkUpdate()}>
          检查更新
        </Button>
      )}

      {status.state === "checking" && (
        <p className="text-body text-muted-foreground">检查中…</p>
      )}

      {status.state === "no-update" && (
        <div className="flex items-center gap-3">
          <p className="text-body text-muted-foreground">当前已是最新版本。</p>
          <Button variant="outline" size="sm" onClick={() => void checkUpdate()}>重新检查</Button>
        </div>
      )}

      {status.state === "available" && (
        <div className="flex flex-col gap-2">
          <p className="text-body font-medium">发现新版本 v{status.version}</p>
          {status.notes && (
            <p className="text-meta text-muted-foreground whitespace-pre-wrap max-h-32 overflow-y-auto">
              {status.notes}
            </p>
          )}
          <p className="text-meta text-muted-foreground">
            确认后将下载并安装新版本,安装完成后应用会重启。
          </p>
          <div className="flex gap-2">
            <Button className="w-fit" onClick={() => void confirmAndInstall()}>
              确认安装 v{status.version}
            </Button>
            <Button variant="outline" className="w-fit" onClick={cancelUpdate}>
              稍后
            </Button>
          </div>
        </div>
      )}

      {status.state === "downloading" && (
        <div className="flex flex-col gap-2">
          <p className="text-body text-muted-foreground">下载中… {status.progress}%</p>
          <div className="h-1.5 w-full max-w-xs bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${status.progress}%` }}
            />
          </div>
        </div>
      )}

      {status.state === "installing" && (
        <p className="text-body text-muted-foreground">安装中,完成后应用将重启…</p>
      )}

      {status.state === "error" && (
        <div className="flex flex-col gap-2">
          <p className="text-body text-destructive">检查更新失败:{status.message}</p>
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void checkUpdate()}>
            重试
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
