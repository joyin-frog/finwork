/**
 * GET /api/test-fixtures?name=xxx
 * 仅供 e2e/截图测试使用:从 tests/fixtures/ 返回指定文件的二进制内容。
 * 生产环境不会被用到(Tauri 打包后无 tests/fixtures)。
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  if (!name || /[/\\]|\.\./.test(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const filepath = path.join(process.cwd(), "tests", "fixtures", name);
  if (!fs.existsSync(filepath)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const data = fs.readFileSync(filepath);
  const ext = path.extname(name).toLowerCase().slice(1);
  const mimeMap: Record<string, string> = {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    json: "application/json",
  };
  const contentType = mimeMap[ext] ?? "application/octet-stream";
  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}
