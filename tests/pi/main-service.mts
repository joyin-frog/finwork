import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPiPrompt,
  validatePiSessionLocator,
} from "../../lib/agent/pi/agent-service.ts";

const root = mkdtempSync(path.join(tmpdir(), "finwork-pi-main-service-"));
const sessions = path.join(root, "sessions");
mkdirSync(sessions, { recursive: true });
const sessionFile = path.join(sessions, "session.jsonl");
writeFileSync(sessionFile, "{}\n", "utf8");

assert.equal(validatePiSessionLocator(sessionFile, sessions), realpathSync(sessionFile));
assert.throws(
  () => validatePiSessionLocator(path.join(root, "outside.jsonl"), sessions),
  /不存在|受控目录/,
);
const outside = path.join(root, "outside.jsonl");
writeFileSync(outside, "{}\n", "utf8");
assert.throws(() => validatePiSessionLocator(outside, sessions), /受控目录/);

const fresh = buildPiPrompt(
  [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "当前请求" },
  ],
  [{
    name: "note.txt",
    mimeType: "text/plain",
    size: 4,
    dataUrl: "data:text/plain;base64,bm90ZQ==",
    text: "note",
  }],
  false,
);
assert.match(fresh.text, /<对话回顾>/);
assert.match(fresh.text, /当前请求/);
assert.match(fresh.text, /<attachment name="note.txt">/);

const resumed = buildPiPrompt(
  [
    { role: "user", content: "旧问题" },
    { role: "assistant", content: "旧回答" },
    { role: "user", content: "只发这一条" },
  ],
  [],
  true,
);
assert.equal(resumed.text, "只发这一条");
assert.equal(resumed.images.length, 0);

const image = buildPiPrompt(
  [{ role: "user", content: "看图" }],
  [{
    name: "red.png",
    mimeType: "image/png",
    size: 3,
    dataUrl: "data:image/png;base64,cmVk",
  }],
  false,
);
assert.equal(image.images.length, 1);
assert.equal(image.images[0].data, "cmVk");

const csvPath = path.join(root, "payroll.csv");
writeFileSync(csvPath, "name,gross\n张敏,20000\n", "utf8");
const localText = buildPiPrompt(
  [{ role: "user", content: "计算附件工资" }],
  [{
    name: "payroll.csv",
    mimeType: "text/csv",
    size: 25,
    dataUrl: "",
    storagePath: csvPath,
  }],
  false,
);
assert.match(localText.text, /张敏,20000/);
assert.match(localText.text, /无需调用工具读取/);
assert.doesNotMatch(localText.text, /请用 read_document/);

console.log("Pi main service ✓ controlled locator, fresh/resume prompt and attachments");
