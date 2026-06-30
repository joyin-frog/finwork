import type { NextRequest } from "next/server";

/**
 * Browser cross-site requests must not trigger local destructive or sensitive operations.
 * CLI/Tauri calls without browser fetch metadata remain allowed.
 */
export function isTrustedLocalMutation(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = req.headers.get("origin");
  return !origin || origin === req.nextUrl.origin;
}
