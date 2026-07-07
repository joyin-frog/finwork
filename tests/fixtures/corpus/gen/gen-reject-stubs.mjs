#!/usr/bin/env node
/**
 * 生成两个拒绝路径样本（内容任意，测试只验证解析器是否正确拒绝）：
 *   corpus/xls-legacy-format.xls     — 触发 .xls 拒绝路径
 *   corpus/unknown-format.bin         — 触发未知类型拒绝路径
 *
 * 这两个文件内容是占位字节，不是真实 Excel 数据。测试通过 mimeType 触发拒绝，不解析文件内容。
 *
 * 运行方式（在仓库根目录）：
 *   node tests/fixtures/corpus/gen/gen-reject-stubs.mjs
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..");

// xls 拒绝样本：内容是任意字节（CFB 魔数，Excel 95/97 格式标识）
// 实际 parseDocument 在 mimeType 匹配时检查扩展名，无需真实格式
writeFileSync(
  path.join(OUT, "xls-legacy-format.xls"),
  Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00])
);
console.log("已生成：xls-legacy-format.xls");

// 未知扩展名拒绝样本：纯占位字节
writeFileSync(
  path.join(OUT, "unknown-format.bin"),
  Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])
);
console.log("已生成：unknown-format.bin");

console.log("全部拒绝样本已生成。");
