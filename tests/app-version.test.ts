/**
 * 单测:关于页「当前版本」展示串的净化。
 * 版本号由构建期注入(NEXT_PUBLIC_APP_VERSION),缺失/脏值时不能露出 "vundefined" / 空 "v"。
 */
import assert from "node:assert/strict";
import { formatAppVersion } from "../lib/version/format";

const { equal } = assert;

async function main() {
  // 正常版本号:补 v 前缀
  equal(formatAppVersion("0.1.4"), "v0.1.4");
  // 已带 v/V 前缀:不重复加,统一小写 v
  equal(formatAppVersion("v0.1.4"), "v0.1.4");
  equal(formatAppVersion("V2.0"), "v2.0");
  // 首尾空白:trim 后再判断
  equal(formatAppVersion("  1.2.3  "), "v1.2.3");
  // 缺失/空:兜底文案,绝不出现 "vundefined" / "v"
  equal(formatAppVersion(undefined), "版本未知");
  equal(formatAppVersion(""), "版本未知");
  equal(formatAppVersion("   "), "版本未知");
  // 只有一个 v 也算无效
  equal(formatAppVersion("v"), "版本未知");

  console.log("app-version tests passed");
}

export const appVersionTestPromise = main();
