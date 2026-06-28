"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/app/config/settings-ui";
import { toast } from "sonner";
import type { CompanyProfile } from "@/lib/profile/file-store";
import { INDUSTRY_OPTIONS } from "@/lib/profile/industry-options";

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function ProfileSettings() {
  const [profile, setProfile] = useState<CompanyProfile>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // 年营收原始输入(用于就地校验:非法值标红且不写入,不静默存脏值)
  const [revenueRaw, setRevenueRaw] = useState("");
  const [revenueError, setRevenueError] = useState(false);
  // 首个 post-load 渲染是加载进来的数据,不应触发自动保存
  const hydrated = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/profile");
        const payload = (await res.json()) as {
          ok: boolean;
          data?: { profile: CompanyProfile; updatedAt: string | null };
        };
        if (payload.ok && payload.data) {
          setProfile(payload.data.profile);
          setUpdatedAt(payload.data.updatedAt);
          setRevenueRaw(
            payload.data.profile.scaleRevenueWan != null
              ? String(payload.data.profile.scaleRevenueWan)
              : ""
          );
        }
      } catch {
        toast.error("公司画像加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 自动保存:字段变更防抖 600ms 落库,带状态指示(去掉手动保存按钮)
  useEffect(() => {
    if (loading) return;
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const t = setTimeout(() => {
      void (async () => {
        setStatus("saving");
        try {
          const res = await fetch("/api/profile", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
          const payload = (await res.json()) as { ok: boolean; error?: string };
          if (payload.ok) {
            setUpdatedAt(new Date().toISOString());
            setStatus("saved");
          } else {
            setStatus("error");
          }
        } catch {
          setStatus("error");
        }
      })();
    }, 600);
    return () => clearTimeout(t);
  }, [profile, loading]);

  function updateField<K extends keyof CompanyProfile>(key: K, value: CompanyProfile[K] | "") {
    setProfile((prev) => {
      if (value === "" || value === null || value === undefined) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
  }

  // 年营收单独处理:保留原始输入显示,非法(非数字/≤0)标红且不写入字段
  function onRevenueChange(raw: string) {
    setRevenueRaw(raw);
    const trimmed = raw.trim();
    if (trimmed === "") {
      setRevenueError(false);
      updateField("scaleRevenueWan", undefined);
      return;
    }
    const v = Number(trimmed);
    if (Number.isFinite(v) && v > 0) {
      setRevenueError(false);
      updateField("scaleRevenueWan", v);
    } else {
      setRevenueError(true); // 不调用 updateField:脏值不进 profile、不被自动保存
    }
  }

  const fieldLabel = (label: string, hint?: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-body font-medium">{label}</span>
      {hint && <span className="text-meta text-muted-foreground">{hint}</span>}
    </div>
  );

  const statusText =
    status === "saving" ? "保存中…"
      : status === "saved" ? "已保存 ✓"
        : status === "error" ? "保存失败,请重试"
          : "";

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="公司画像"
        description="小财会在对话中逐步补全，也可以在这里直接编辑（自动保存）。每次对话自动注入，支撑税务优惠发现和经营分析。"
      >
        <div className="-mt-1 flex items-center gap-2 text-meta text-muted-foreground">
          {updatedAt && <span>上次更新：{new Date(updatedAt).toLocaleString("zh-CN")}</span>}
          {statusText && (
            <span className={status === "error" ? "text-destructive" : status === "saved" ? "text-[color:var(--tone-ok)]" : ""}>
              {statusText}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {fieldLabel("所在地区", "如「上海市松江区」")}
            <Input
              value={profile.region ?? ""}
              onChange={(e) => updateField("region", e.target.value)}
              placeholder="上海市松江区"
              disabled={loading}
            />
          </div>

          <div className="flex flex-col gap-2">
            {fieldLabel("所在园区", "多个用逗号分隔，如「临港新片区」")}
            <Input
              value={(profile.zones ?? []).join("、")}
              onChange={(e) => {
                const val = e.target.value.trim();
                updateField("zones", val ? val.split(/[，,、]+/).map((s) => s.trim()).filter(Boolean) : []);
              }}
              placeholder="临港新片区"
              disabled={loading}
            />
          </div>

          <div className="flex flex-col gap-2">
            {fieldLabel("纳税人类型")}
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-body shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={profile.taxpayerType ?? ""}
              onChange={(e) => {
                const val = e.target.value as "" | "小规模" | "一般纳税人";
                if (val === "") updateField("taxpayerType", undefined);
                else updateField("taxpayerType", val);
              }}
              disabled={loading}
            >
              <option value="">（未填写）</option>
              <option value="小规模">小规模纳税人</option>
              <option value="一般纳税人">一般纳税人</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="isHighTech"
              checked={profile.isHighTech ?? false}
              onChange={(e) => updateField("isHighTech", e.target.checked)}
              disabled={loading}
              className="h-4 w-4 rounded border-input"
            />
            <label htmlFor="isHighTech" className="text-body">
              高新技术企业（影响所得税率和研发加计扣除）
            </label>
          </div>

          <div className="flex flex-col gap-2">
            {fieldLabel("所属行业", "可从列表选择，也可直接输入")}
            <Input
              list="industry-options"
              value={profile.industry ?? ""}
              onChange={(e) => updateField("industry", e.target.value)}
              placeholder="软件和信息技术服务"
              disabled={loading}
            />
            <datalist id="industry-options">
              {INDUSTRY_OPTIONS.map((opt) => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
          </div>

          <div className="flex flex-col gap-2">
            {fieldLabel("年营收（万元）", "近一年含税营业收入")}
            <Input
              type="number"
              min={0}
              value={revenueRaw}
              onChange={(e) => onRevenueChange(e.target.value)}
              placeholder="1000"
              disabled={loading}
              aria-invalid={revenueError}
              className={revenueError ? "border-destructive focus-visible:ring-destructive" : undefined}
            />
            {revenueError && (
              <span className="text-meta text-destructive">请输入大于 0 的数字，当前值未保存。</span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {fieldLabel("收入拆分维度", "多个用逗号分隔，如「事业部」「产品线」——经营分析下钻用")}
            <Input
              value={(profile.revenueDimensions ?? []).join("、")}
              onChange={(e) => {
                const val = e.target.value.trim();
                updateField(
                  "revenueDimensions",
                  val ? val.split(/[，,、]+/).map((s) => s.trim()).filter(Boolean) : []
                );
              }}
              placeholder="事业部、产品线"
              disabled={loading}
            />
          </div>
        </div>

        <p className="text-meta text-muted-foreground">
          税务优惠发现：在对话中发送「帮我做税务优惠排查」；研发加计核查：发送「帮我核查研发费用加计扣除」。
        </p>
      </SettingsSection>
    </div>
  );
}
