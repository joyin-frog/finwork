import assert from "node:assert/strict";
import { parseCodeLanguage } from "../app/chat/code-language.ts";

// 从 react-markdown/rehype-highlight 给 <code> 的 className 里取语言名。
assert.equal(parseCodeLanguage("language-python hljs"), "python", "前置 language- + hljs");
assert.equal(parseCodeLanguage("hljs language-ts"), "ts", "language- 在后");
assert.equal(parseCodeLanguage("language-c++"), "c++", "保留 + 号(c++)");
assert.equal(parseCodeLanguage("language-c#"), "c#", "保留 # 号(c#)");
assert.equal(parseCodeLanguage("language-objective-c"), "objective-c", "保留连字符");
assert.equal(parseCodeLanguage("hljs"), null, "无 language- → null");
assert.equal(parseCodeLanguage(""), null, "空串 → null");
assert.equal(parseCodeLanguage(undefined), null, "undefined → null(防御)");

console.log("✓ PASS: code-language parseCodeLanguage");

export const codeLanguageTestPromise = Promise.resolve();
