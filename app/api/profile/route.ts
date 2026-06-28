import { NextResponse } from "next/server";
import { readCompanyProfile, writeCompanyProfile, type CompanyProfile } from "@/lib/profile/file-store";
import { getProfilePath } from "@/lib/runtime/paths";
import { existsSync, statSync } from "node:fs";

export async function GET() {
  try {
    const profile = await readCompanyProfile();
    const filePath = getProfilePath();
    const updatedAt = existsSync(filePath)
      ? new Date(statSync(filePath).mtimeMs).toISOString()
      : null;
    return NextResponse.json({ ok: true, data: { profile, updatedAt } });
  } catch (error) {
    console.error("[profile] GET error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "读取失败" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).profile !== "object") {
    return NextResponse.json({ ok: false, error: "profile 字段必须为对象" }, { status: 400 });
  }

  const profile = (body as { profile: CompanyProfile }).profile;
  try {
    await writeCompanyProfile(profile);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[profile] PUT error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "写入失败" },
      { status: 500 }
    );
  }
}
