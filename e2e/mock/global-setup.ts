import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

// mock e2e 每次跑前重置隔离 app-data,保证确定性(空 DB / 空知识库 / 空会话)。
// 真 key 模式用的是 ../global-setup.ts(沙箱注入真 key),与此互不影响。
export default function globalSetup() {
  const dir = path.join(process.cwd(), ".claude", "e2e-mock", "appdata");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
