import assert from "node:assert/strict";
import { stripFileLinks } from "../lib/text/strip-file-links";

export const stripFileLinksTestPromise = (async () => {
  // ① markdown 链接降级为纯文本
  assert.equal(
    stripFileLinks("[report.xlsx](sandbox:/Users/x/files/38/report.xlsx)"),
    "report.xlsx",
    "① markdown 链接应降级为 link text"
  );

  // ② 裸 sandbox: URL 被清掉
  assert.equal(
    stripFileLinks("请看这里 sandbox:/Users/x/files/38/report.xlsx 谢谢"),
    "请看这里  谢谢",
    "② 裸 sandbox: URL 应被移除"
  );

  // ③ 同一段多个链接都处理
  assert.equal(
    stripFileLinks("[A.pptx](sandbox:/a/A.pptx) 和 [B.xlsx](sandbox:/b/B.xlsx)"),
    "A.pptx 和 B.xlsx",
    "③ 多个 markdown 链接都应降级"
  );

  // ④ 含中文文件名 + 百分号编码的 sandbox 链接
  assert.equal(
    stripFileLinks(
      "[上海都森重新生成2.pptx](sandbox:/Users/x/files/38/generate/%E4%B8%8A%E6%B5%B7%E9%83%BD%E6%A3%AE2.pptx)"
    ),
    "上海都森重新生成2.pptx",
    "④ 含中文文件名 + 百分号编码的 sandbox 链接应正确降级"
  );

  // ⑤ 普通文本不变
  assert.equal(
    stripFileLinks("这是一段普通的财务分析文字,没有任何链接。"),
    "这是一段普通的财务分析文字,没有任何链接。",
    "⑤ 普通文本不应被修改"
  );

  // ⑥ 空串返回空串
  assert.equal(stripFileLinks(""), "", "⑥ 空串应返回空串");

  // 额外:file: scheme 裸 URL 也应被清掉
  assert.equal(
    stripFileLinks("附件 file:///Users/x/doc.pdf 已生成"),
    "附件  已生成",
    "file: 裸 URL 应被移除"
  );

  // ⑦ 回归:URL 里含字面括号(文件名 公司(2)),不能在第一个 ) 截断
  assert.equal(
    stripFileLinks(
      "文件在这里： [上海都森电子科技有限公司(2)_营业预测更新_重新生成2.pptx](sandbox:/Users/user/Library/Application Support/finance-agent/files/38/generate/上海都森电子科技有限公司(2)_%E8%90%A5%E4%B8%9A_重新生成2.pptx)"
    ),
    "文件在这里： 上海都森电子科技有限公司(2)_营业预测更新_重新生成2.pptx",
    "⑦ URL 含字面括号时应整段吃掉、不残留百分号编码尾巴"
  );

  // ⑧ 非链接的方括号/括号文本保持原样
  assert.equal(
    stripFileLinks("见步骤[1]和(备注)说明"),
    "见步骤[1]和(备注)说明",
    "⑧ 非链接的 [] 和 () 不应被改动"
  );

  console.log("strip-file-links: all 9 checks passed ✓");
})();
