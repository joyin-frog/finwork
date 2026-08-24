"use client";

/**
 * 自动更新 UI(Electron updater)。
 * 人工审核门:发现新版本后必须用户确认才下载安装。
 *
 * 只在桌面壳内工作;Web 模式(Next.js dev / 浏览器)下静默隐藏。
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getDesktop } from "@/lib/desktop/client";

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "no-update" }
  | { state: "available"; version: string; notes: string | null }
  | { state: "downloading"; progress: number }
  | { state: "installing" }
  | { state: "error"; message: string };

/**
 * 把底层错误翻成可操作提示。更新通道要真正可用,需先完成发布签名配置
 * (见 docs/updater-signing.md);本地/未配置环境下 check() 会失败,属预期。
 */
function friendlyUpdaterError(err: unknown): string {
  const m = String(err);
  if (/Cannot find module|electron-updater/i.test(m)) {
    return "更新依赖未安装。请在项目根目录跑 npm install 后重启应用。";
  }
  if (/signature|code.?sign|verify/i.test(m)) {
    return "更新包签名校验失败。请确认发布产物已完成 Windows 代码签名或 macOS 签名与公证。";
  }
  if (/fetch|network|endpoint|404|could not|resolve|json|parse/i.test(m)) {
    return "未找到可用更新源:GitHub Release 尚未发布更新元数据,或网络暂时不可用。";
  }
  return m;
}

export function UpdaterBody() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [pendingUpdate, setPendingUpdate] = useState<{
    version: string;
    notes: string | null;
  } | null>(null);

  const desktop = getDesktop();
  if (!desktop) return null;
  const updater = desktop.updater;

  async function checkUpdate() {
    setStatus({ state: "checking" });
    try {
      const update = await updater.check();
      if (!update) {
        setStatus({ state: "no-update" });
        return;
      }
      setPendingUpdate({
        version: update.version,
        notes: update.notes,
      });
      setStatus({ state: "available", version: update.version, notes: update.notes });
    } catch (err) {
      setStatus({ state: "error", message: friendlyUpdaterError(err) });
    }
  }

  /** 用户确认后才下载安装(人工审核门)。 */
  async function confirmAndInstall() {
    if (!pendingUpdate) return;
    try {
      setStatus({ state: "downloading", progress: 0 });
      await updater.download((progress) => setStatus({ state: "downloading", progress }));
      setStatus({ state: "installing" });
      await updater.install();
    } catch (err) {
      setStatus({ state: "error", message: friendlyUpdaterError(err) });
    }
  }

  function cancelUpdate() {
    setPendingUpdate(null);
    setStatus({ state: "idle" });
  }

  return (
    <>
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
          {/* eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则 */}
          <div className="h-1.5 w-full max-w-xs bg-muted rounded-full overflow-hidden">
            <div
              className="h-full w-full origin-left bg-primary transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ transform: `scaleX(${Math.min(100, Math.max(0, status.progress)) / 100})` }}
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
    </>
  );
}
