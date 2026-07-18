"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
import { toast } from "sonner";
import type { CompanyProfile } from "@/lib/profile/file-store";
import { INDUSTRY_OPTIONS } from "@/lib/profile/industry-options";

export function ProfileSettings() {
  const [profile, setProfile] = useState<CompanyProfile>({});
  const [loading, setLoading] = useState(true);
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
          data?: { profile: CompanyProfile };
        };
        if (payload.ok && payload.data) {
          setProfile(payload.data.profile);
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

  // 自动保存:字段变更防抖 600ms 落库;失败用 toast 提示,不为成功状态预留布局。
  useEffect(() => {
    if (loading) return;
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/profile", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
          const payload = (await res.json()) as { ok: boolean; error?: string };
          if (!payload.ok) toast.error("公司画像保存失败");
        } catch {
          toast.error("公司画像保存失败");
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

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="公司画像"
        description="支撑税务优惠发现和经营分析。"
      >
        <SettingsRow label="所在地区">
          <Input
            value={profile.region ?? ""}
            onChange={(e) => updateField("region", e.target.value)}
            placeholder="上海市松江区"
            disabled={loading}
          />
        </SettingsRow>

        <SettingsRow label="所在园区">
          <Input
            value={(profile.zones ?? []).join("、")}
            onChange={(e) => {
              const val = e.target.value.trim();
              updateField("zones", val ? val.split(/[，,、]+/).map((s) => s.trim()).filter(Boolean) : []);
            }}
            placeholder="临港新片区"
            disabled={loading}
          />
        </SettingsRow>

        <SettingsRow label="纳税人类型">
          <Select
            value={profile.taxpayerType ?? ""}
            onValueChange={(value) => {
              if (value === "unset") updateField("taxpayerType", undefined);
              else updateField("taxpayerType", value as "小规模" | "一般纳税人");
            }}
            disabled={loading}
          >
            <SelectTrigger className="h-8 w-full" aria-label="纳税人类型">
              <SelectValue placeholder="（未填写）" />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectGroup>
                <SelectItem value="unset">（未填写）</SelectItem>
                <SelectItem value="小规模">小规模纳税人</SelectItem>
                <SelectItem value="一般纳税人">一般纳税人</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label="高新技术企业" hint="影响所得税率和研发加计扣除">
          <Switch
            id="isHighTech"
            checked={profile.isHighTech ?? false}
            onCheckedChange={(v) => updateField("isHighTech", v)}
            disabled={loading}
          />
        </SettingsRow>

        <SettingsRow label="所属行业">
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
        </SettingsRow>

        <SettingsRow label="年营收（万元）">
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
            <span className="block text-meta text-destructive">请输入大于 0 的数字，当前值未保存。</span>
          )}
        </SettingsRow>

        <SettingsRow label="收入拆分维度">
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
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
