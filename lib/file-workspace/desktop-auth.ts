import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAppDataDir } from "@/lib/runtime/paths";

export async function authorizedByDesktop(request: Request): Promise<boolean> {
  const supplied = request.headers.get("x-finwork-workspace-auth") ?? "";
  if (!supplied) return false;
  try {
    const expected = (await readFile(path.join(getAppDataDir(), "workspace-auth-token"), "utf8")).trim();
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
