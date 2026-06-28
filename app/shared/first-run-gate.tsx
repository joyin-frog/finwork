"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

// 装好/跳过后不再打扰:组件就绪与 Key 提示在一个会话内一次性。
const SESSION_OK = "fa-firstrun-ready";
const SESSION_KEY_PROMPTED = "fa-firstrun-key-prompted";

type DoctorResult = { ok: boolean; detail: string; missing?: string[] };
type StepStatus = "done" | "needed";
type Phase = "install" | "model";

/**
 * 首启设置门:顺序向导。① 安装组件——检测到缺则自动安装,只显进度条、不可手动跳过;装完(或失败两次后)
 * 才能「下一步」。② 连模型——点「下一步」后才进,可跳过;只录 URL/Key/主模型(快速/推理走默认,留给设置页)。
 * 挂在 AppShell,空闲时自检一次;装好/跳过后不再弹。
 */
export function FirstRunGate({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("install");

  const [keyStep, setKeyStep] = useState<StepStatus>("done");
  const [installStep, setInstallStep] = useState<StepStatus>("done");

  // ① 装组件
  const [installMissing, setInstallMissing] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");
  const [installProgress, setInstallProgress] = useState(0);
  const [installAttempts, setInstallAttempts] = useState(0);
  const autoStarted = useRef(false);

  // ② 连模型(只主模型)
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [keyError, setKeyError] = useState("");

  const runSelfCheck = useCallback(async () => {
    try {
      const doctor = (await (await fetch("/api/settings/doctor")).json()) as {
        data?: { python?: DoctorResult; apiKeyConfigured?: boolean };
      };
      const keyOk = doctor.data?.apiKeyConfigured === true;
      const py = doctor.data?.python;
      const pyOk = !py || py.ok;

      const keySkipped = Boolean(sessionStorage.getItem(SESSION_KEY_PROMPTED));
      const installSkipped = Boolean(sessionStorage.getItem(SESSION_OK));

      setKeyStep(keyOk ? "done" : "needed");
      setInstallStep(pyOk ? "done" : "needed");
      if (!pyOk) setInstallMissing(py?.missing ?? []);

      const needKey = !keyOk && !keySkipped;
      const needInstall = !pyOk && !installSkipped;
      if (!(needKey || needInstall)) return;

      // 缺组件 → 从安装步起(自动装);否则直接进连模型步
      setPhase(needInstall ? "install" : "model");

      // 连模型需要时预填当前 URL/模型(用户可能填过一半)
      if (needKey) {
        try {
          const s = (await (await fetch("/api/settings/claude")).json()) as { data?: { apiUrl?: string; model?: string } };
          setApiUrl(s.data?.apiUrl || "https://api.anthropic.com");
          setModel(s.data?.model || "");
        } catch { setApiUrl("https://api.anthropic.com"); }
      }
      setOpen(true);
    } catch {
      // 自检本身失败不把用户锁在门外:放行,基础功能仍可用
      sessionStorage.setItem(SESSION_OK, "1");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem(SESSION_KEY_PROMPTED) && sessionStorage.getItem(SESSION_OK)) return;
    let cancelled = false;
    // doctor 会拉起 Python 子进程,别和首屏抢资源——等空闲再跑。
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    const usedRic = typeof w.requestIdleCallback === "function";
    const handle = usedRic
      ? w.requestIdleCallback!(() => { if (!cancelled) void runSelfCheck(); }, { timeout: 3000 })
      : window.setTimeout(() => { if (!cancelled) void runSelfCheck(); }, 1500);
    return () => { cancelled = true; if (usedRic) w.cancelIdleCallback?.(handle); else window.clearTimeout(handle); };
  }, [runSelfCheck]);

  const installComponents = useCallback(async () => {
    setInstalling(true);
    setInstallError("");
    setInstallProgress(6);
    setInstallAttempts((a) => a + 1);
    // 真实时长由网络下载主导、不可预知,无逐字节进度;用平滑爬升的估算条给「一直在动」的反馈,
    // 向 90% 减速逼近(不到顶),装好瞬间补到 100%。
    const timer = setInterval(() => {
      setInstallProgress((p) => (p < 90 ? p + Math.max(0.4, (90 - p) * 0.05) : p));
    }, 360);
    try {
      const body = (await (await fetch("/api/settings/python/install", { method: "POST" })).json()) as { ok: boolean; data?: { detail?: string } };
      if (body.ok) {
        setInstallProgress(100);
        setInstallStep("done");
        sessionStorage.setItem(SESSION_OK, "1");
      } else {
        setInstallError(body.data?.detail || "安装失败,请稍后重试。");
      }
    } catch {
      setInstallError("安装失败(网络异常),请稍后重试。");
    } finally {
      clearInterval(timer);
      setInstalling(false);
    }
  }, []);

  // 进入安装步且检测到缺组件 → 自动开始安装(只一次)
  useEffect(() => {
    if (open && phase === "install" && installStep === "needed" && !autoStarted.current) {
      autoStarted.current = true;
      void installComponents();
    }
  }, [open, phase, installStep, installComponents]);

  function goNext() {
    // 装组件就绪(或失败两次跳过)→ 需要连模型则进第二步,否则收尾
    if (keyStep === "needed") setPhase("model");
    else closeGate();
  }

  function closeGate() {
    sessionStorage.setItem(SESSION_KEY_PROMPTED, "1");
    sessionStorage.setItem(SESSION_OK, "1");
    setOpen(false);
  }

  async function finishModel() {
    if (!apiKey.trim()) { closeGate(); return; }
    setConnecting(true);
    setKeyError("");
    try {
      await fetch("/api/settings/claude", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiUrl: apiUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }),
      });
      closeGate();
    } catch {
      setKeyError("保存失败,可点「跳过」稍后在设置里配置。");
      setConnecting(false);
    }
  }

  if (!open) return <>{children}</>;

  const canSkipInstall = installAttempts >= 2 && !!installError && !installing;

  return (
    <>
      {children}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <div className="w-[540px] max-w-[92vw] max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-background p-6 shadow-[var(--elevation-3)] flex flex-col gap-5">
          <h2 className="text-title">欢迎用小财</h2>

          {/* ① 装组件 */}
          <section className="flex flex-col gap-2">
            <StepHeader n={1} title="安装组件" status={installStep} />
            {phase === "install" && installStep === "needed" && (
              <div className="flex flex-col gap-2 pl-7">
                {installMissing.length > 0 && <p className="text-meta text-muted-foreground">缺少:{installMissing.join("、")}</p>}
                {installing ? (
                  <div className="flex flex-col gap-1.5">
                    <Progress value={installProgress} className="h-1.5" />
                    <span className="text-meta text-muted-foreground">正在安装,请稍候… {Math.round(installProgress)}%</span>
                  </div>
                ) : installError ? (
                  <p className="text-meta text-[color:var(--tone-alarm)]">{installError}{installAttempts < 2 ? "(可重试)" : ""}</p>
                ) : null}
              </div>
            )}
          </section>

          {/* ② 连模型 */}
          <section className="flex flex-col gap-2">
            <StepHeader
              n={2}
              title="连模型"
              status={keyStep}
              optional={phase === "model"}
              hint={phase === "model" && keyStep === "needed" ? "填好就能让小财真正处理任务(不填只能浏览)" : undefined}
            />
            {phase === "model" && keyStep === "needed" && (
              <div className="flex flex-col gap-2 pl-7">
                <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="API URL，如 https://api.anthropic.com" />
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key（sk-...）" />
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="主模型，如 claude-opus-4-8 / deepseek-v4-pro" />
                <p className="text-meta text-muted-foreground">快速 / 推理模型用默认,可稍后在 设置 → 模型 调整。</p>
                {keyError && <p className="text-meta text-[color:var(--tone-alarm)]">{keyError}</p>}
              </div>
            )}
          </section>

          {/* 底部:install 步只有「下一步」(装完/跳过才可点);model 步是「跳过 / 完成」 */}
          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            {phase === "install" ? (
              installStep === "done" ? (
                <Button size="sm" onClick={goNext}>下一步</Button>
              ) : canSkipInstall ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => void installComponents()}>重试</Button>
                  <Button size="sm" variant="ghost" onClick={goNext}>暂时跳过</Button>
                </>
              ) : installError && !installing ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => void installComponents()}>重试</Button>
                  <Button size="sm" disabled>下一步</Button>
                </>
              ) : (
                <Button size="sm" disabled>下一步</Button>
              )
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={closeGate}>跳过</Button>
                <Button size="sm" onClick={() => void finishModel()} disabled={connecting}>{connecting ? "保存中…" : "完成"}</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StepHeader({ n, title, status, hint, optional }: { n: number; title: string; status: StepStatus; hint?: string; optional?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className={cn(
        "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-meta font-medium",
        status === "done" ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground"
      )}>{status === "done" ? "✓" : n}</span>
      <div className="flex flex-col">
        <span className="text-body font-medium">
          {title}
          {status === "done" && <span className="ml-2 text-meta text-muted-foreground font-normal">已就绪</span>}
          {optional && status !== "done" && <span className="ml-2 text-meta text-muted-foreground font-normal">可跳过</span>}
        </span>
        {status === "needed" && hint && <span className="text-meta text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}
