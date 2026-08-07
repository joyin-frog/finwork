import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

// mock e2e 每次跑前重置隔离 app-data,保证确定性(空 DB / 空知识库 / 空会话)。
// 真 key 模式用的是 ../global-setup.ts(沙箱注入真 key),与此互不影响。
export default function globalSetup() {
  // fast 模式(BASE_URL 指向 test:e2e:serve 起的常驻服务器):app-data 归那台服务器所有,
  // 不能从它脚下删库(已打开的 SQLite fd 会指向被 unlink 的旧 inode,状态错乱)。
  // 代价:状态跨次累积;要干净基线就重启 test:e2e:serve(它起服前会重置目录)。
  if (process.env.BASE_URL) return;
  const dir = path.join(process.cwd(), ".finwork-test", "e2e-mock", "appdata");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
