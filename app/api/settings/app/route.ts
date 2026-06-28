/**
 * /api/settings/app — 轻量 key-value app 设置接口(供客户端读写 app_settings 表)。
 *
 * GET  ?key=<key>           → { ok, data: { value: string | null } }
 * PUT  { key, value }       → { ok }
 *
 * 仅限 telemetry:disclosureShown 等非敏感 UI 标志;不暴露任何凭证或财务数据。
 */
import { NextRequest, NextResponse } from "next/server";
import { getAppSetting, setAppSetting } from "@/lib/db/sqlite";

// 允许通过此接口读写的 key 白名单(防止客户端任意读写 app_settings)。
const ALLOWED_KEYS = new Set(["telemetry:disclosureShown"]);

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  if (!key || !ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ ok: false, error: "invalid key" }, { status: 400 });
  }
  try {
    const value = getAppSetting(key) ?? null;
    return NextResponse.json({ ok: true, data: { value } });
  } catch {
    return NextResponse.json({ ok: false, error: "db error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: { key?: string; value?: string };
  try {
    body = (await req.json()) as { key?: string; value?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const { key, value } = body;
  if (!key || !ALLOWED_KEYS.has(key) || typeof value !== "string") {
    return NextResponse.json({ ok: false, error: "invalid key or value" }, { status: 400 });
  }
  try {
    setAppSetting(key, value);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "db error" }, { status: 500 });
  }
}
