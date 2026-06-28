"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow, SettingsField } from "@/app/config/settings-ui";
import type { PublicClaudeSettings } from "@/lib/settings/claude-settings";
import type { TestReportResult } from "@/lib/telemetry/reporter";

type TelemetryStatus = {
  enabled: boolean;
  endpoint: string;
  endpointBuiltIn?: boolean;
  installId: string;
  lastReportedAt: number;
  lastReportedCount: number;
};

function formatTime(epochMs: number): string {
  if (!epochMs) return "从未";
  return new Date(epochMs).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function saveSettings(patch: Partial<PublicClaudeSettings>): Promise<void> {
  await fetch("/api/settings/claude", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function formatTestResult(result: TestReportResult): string {
  if (!result.ok && "reason" in result) {
    return `未上报:${result.reason}`;
  }
  if (result.ok) {
    return `已上报 ${result.traceCount} 条 trace / ${result.appErrorCount} 条错误,接收端 ${result.status}`;
  }
  // ok: false with error
  const r = result as { ok: false; status?: number; traceCount: number; appErrorCount: number; endpoint: string; error: string };
  const statusPart = r.status !== undefined ? ` (状态码 ${r.status})` : "";
  return `上报失败${statusPart}:${r.error}`;
}

export function TelemetrySettings() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [testEndpoint, setTestEndpoint] = useState("");
  const [testToken, setTestToken] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // 加载当前设置 + 上报状态
  useEffect(() => {
    void (async () => {
      const [settingsRes, statusRes] = await Promise.all([
        fetch("/api/settings/claude"),
        fetch("/api/telemetry/status"),
      ]);
      const settingsBody = (await settingsRes.json()) as { data: PublicClaudeSettings };
      const statusBody = (await statusRes.json()) as { data: TelemetryStatus };
      setEnabled(settingsBody.data.telemetryEnabled ?? false);
      setStatus(statusBody.data ?? null);
      setTestEndpoint(settingsBody.data.telemetryEndpoint ?? "");
      setTestToken(settingsBody.data.telemetryToken ?? "");
    })();
  }, []);

  // 开关直接保存(§17.2:无阻塞确认弹框,已改为首启告知)
  async function handleToggle(next: boolean) {
    setEnabled(next);
    await saveSettings({ telemetryEnabled: next });
  }

  async function handleTestEndpointBlur() {
    await saveSettings({ telemetryEndpoint: testEndpoint });
  }

  async function handleTestTokenBlur() {
    await saveSettings({ telemetryToken: testToken });
  }

  async function handleTestReport() {
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/telemetry/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const data = (await res.json()) as TestReportResult;
      setTestResult(formatTestResult(data));
    } catch (err) {
      setTestResult(`请求失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTestLoading(false);
    }
  }

  const builtIn = status?.endpointBuiltIn ?? false;

  return (
    <SettingsSection
      title="使用数据上报(可选)"
      description="将匿名运行指标(token 用量/耗时/成本/错误/路由)上报以改进产品,不含财务数据。默认开启,可随时关闭。"
    >
      <SettingsRow label="启用上报" htmlFor="telemetry-enabled">
        <Switch
          id="telemetry-enabled"
          checked={enabled}
          onCheckedChange={(v) => void handleToggle(v)}
        />
      </SettingsRow>

      {/* §17.1: endpoint/token 已内置时不暴露输入框,只显示只读说明 */}
      <p className="text-meta text-muted-foreground">
        {builtIn
          ? "上报目标已内置(随应用发布版本配置),无需手动填写。"
          : "未检测到内置上报目标,当前版本不会上报数据。"}
      </p>

      {status && (
        <p className="text-meta text-muted-foreground">
          {status.enabled && (status.endpoint || builtIn)
            ? `已上报至 ${builtIn ? "内置接收端" : status.endpoint},最近一次 ${formatTime(status.lastReportedAt)},本批 ${status.lastReportedCount} 条`
            : "上报未启用或未配置接收端"}
        </p>
      )}

      {/* 测试上报区 */}
      <div className="flex flex-col gap-2 border-t border-border/50 pt-3 mt-1">
        <p className="text-meta font-medium text-foreground">测试上报(本地调试)</p>
        <p className="text-meta text-muted-foreground">
          仅本地测试用;打包发布版用内置配置,这里留空即可。
        </p>
        <SettingsField
          label="接收端地址"
          htmlFor="telemetry-test-endpoint"
          hint="留空时使用内置 endpoint"
        >
          <Input
            id="telemetry-test-endpoint"
            type="url"
            placeholder="https://your-telemetry-server.example"
            value={testEndpoint}
            onChange={(e) => setTestEndpoint(e.target.value)}
            onBlur={() => void handleTestEndpointBlur()}
          />
        </SettingsField>
        <SettingsField
          label="上报 Token"
          htmlFor="telemetry-test-token"
          hint="留空时使用内置 token"
        >
          <Input
            id="telemetry-test-token"
            type="password"
            placeholder="Bearer token"
            value={testToken}
            onChange={(e) => setTestToken(e.target.value)}
            onBlur={() => void handleTestTokenBlur()}
          />
        </SettingsField>
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={testLoading}
            onClick={() => void handleTestReport()}
            className="w-fit"
          >
            {testLoading ? "上报中…" : "立即上报(测试)"}
          </Button>
          {testResult && (
            <p className="text-meta text-muted-foreground" data-testid="telemetry-test-result">
              {testResult}
            </p>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
