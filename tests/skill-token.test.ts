/**
 * 单测:技能 token 插入(insertSkillToken)。
 * 关键不变量:插入的 /name 必须是「独立词」(前后是空白或首尾),
 * 否则行内高亮层与「文本里无 token 就剔除引用」的剪枝正则都匹配不到 —— 引用会被悄悄丢掉。
 */
import assert from "node:assert/strict";
import { insertSkillToken } from "../app/chat/skill-token";

const { equal } = assert;

// 与 chat-page 剪枝/高亮同口径的整词正则,用来验证插入结果确实能被识别。
function tokenMatches(text: string, name: string): boolean {
  return new RegExp(`(?<!\\S)/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\S)`).test(text);
}

async function main() {
  // 空文本插入(+ 菜单在空输入框选技能)
  {
    const r = insertSkillToken("", 0, 0, "biz");
    equal(r.text, "/biz ");
    equal(r.caret, 5);
    equal(tokenMatches(r.text, "biz"), true);
  }

  // 光标前紧挨非空白 → 自动补前导空格,保证是独立词
  {
    const r = insertSkillToken("看看", 2, 2, "biz");
    equal(r.text, "看看 /biz ");
    equal(tokenMatches(r.text, "biz"), true);
    equal(r.caret, r.text.length); // 光标落在 token 末尾
  }

  // 光标前已是空白 → 不重复加空格
  {
    const r = insertSkillToken("hi ", 3, 3, "biz");
    equal(r.text, "hi /biz ");
    equal(tokenMatches(r.text, "biz"), true);
  }

  // 经 / 打开:替换 [start,end) 的 "/filter" 段;前面是空白,无需前导空格
  {
    const draft = "看看 /bi";
    const r = insertSkillToken(draft, 3, draft.length, "biz");
    equal(r.text, "看看 /biz ");
    equal(tokenMatches(r.text, "biz"), true);
  }

  // 句中插入:前后都补空白,仍是独立词
  {
    const r = insertSkillToken("ab cd", 2, 2, "x");
    equal(tokenMatches(r.text, "x"), true);
  }

  console.log("skill-token tests passed");
}

export const skillTokenTestPromise = main();
