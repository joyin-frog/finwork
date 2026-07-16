import assert from "node:assert/strict";
import path from "node:path";
import { getDefaultAppDataDir } from "../lib/runtime/paths.ts";

export const runtimePathsTestPromise = (async () => {
  const home = path.join(path.sep, "Users", "finwork-test");

  assert.equal(
    getDefaultAppDataDir("win32", { LOCALAPPDATA: "C:\\Users\\finwork-test\\AppData\\Local" }, home),
    path.join("C:\\Users\\finwork-test\\AppData\\Local", "Finwork"),
    "Windows 应优先使用 LOCALAPPDATA"
  );
  assert.equal(
    getDefaultAppDataDir("win32", {}, home),
    path.join(home, "AppData", "Local", "Finwork"),
    "Windows 缺少 LOCALAPPDATA 时应回落到用户目录下的 AppData/Local"
  );
  assert.equal(
    getDefaultAppDataDir("win32", { LOCALAPPDATA: "" }, home),
    path.join(home, "AppData", "Local", "Finwork"),
    "Windows 的 LOCALAPPDATA 为空时也应使用本地回落目录"
  );
  assert.equal(
    getDefaultAppDataDir("darwin", {}, home),
    path.join(home, "Library", "Application Support", "Finwork"),
    "macOS 应使用 Application Support"
  );
  assert.equal(
    getDefaultAppDataDir("linux", {}, home),
    path.join(home, ".local", "share", "Finwork"),
    "Linux 应回落到 ~/.local/share"
  );

  console.log("runtime-paths: all 5 checks passed ✓");
})();
