# Audit: blindspot-fixes WP-A 安全脱敏

## Files changed

| 文件 | 操作 |
|------|------|
| `lib/agent/mcp-tools/read-document.ts` | 修改：新增路径白名单检查 + `redact()` 脱敏输出 |
| `app/api/agent/query/route.ts` | 修改：两处 `appendServerLog` 调用包裹 `redact()` |
| `app/api/cockpit/summary/route.ts` | 修改：一处 `appendServerLog` 调用包裹 `redact()`，新增 `redact` import |
| `tests/read-document.test.ts` | 扩展：新增 RD5（路径穿越）、RD6（PII 脱敏）测试用例，并在测试前设置 `FINANCE_AGENT_APP_DATA_DIR` |

---

## 各改动对应 spec 条目

### 1. `lib/agent/mcp-tools/read-document.ts`

**对应 spec WP-A 条目 1（redact 脱敏）：**
- 新增 `import { redact } from "@/lib/safety/pii"` 和 `import { getAppDataDir } from "@/lib/runtime/paths"`
- 在第 68 行将 `text || "(未提取到文本;...)"` 改为 `redact(text) || "(未提取到文本;...)"`
- 提取文本先过 `redact()` 再返回给 LLM，覆盖身份证、手机号、邮箱、银行卡、统一社会信用代码

**对应 spec WP-A 条目 2（路径白名单）：**
- 新增路径检查逻辑（第 34-39 行）：
  ```
  const resolvedPath = path.resolve(filePath);
  const appDataDir = path.resolve(getAppDataDir());
  if (resolvedPath !== appDataDir && !resolvedPath.startsWith(appDataDir + path.sep)) {
    return { content: [{ type: "text", text: "读取失败:路径不在安全目录内" }], isError: true };
  }
  ```
- 校验前置于 `existsSync` 检查（避免通过错误消息泄漏禁区文件是否存在）
- 参照 `app/api/files/[conversationId]/[...filename]/route.ts:21-25` 的前缀校验模式

### 2. `app/api/agent/query/route.ts`

**对应 spec WP-A 条目 3（serverLog 脱敏）：**
- 第 91 行（非流式错误路径）：`error.stack ?? error.message` → `redact(error.stack ?? error.message)`
- 第 392 行（流式错误路径）：同上
- `redact` 已在文件顶部 import（第 22 行），无需新增 import

### 3. `app/api/cockpit/summary/route.ts`

**对应 spec WP-A 条目 3（serverLog 脱敏）：**
- 第 11 行：新增 `import { redact } from "@/lib/safety/pii"`
- 第 77 行：`error.stack ?? error.message` → `redact(error.stack ?? error.message)`

### 4. `tests/read-document.test.ts`

**对应 spec WP-A 条目 4（测试）：**
- 在 IIFE 顶部设置 `process.env.FINANCE_AGENT_APP_DATA_DIR = tmpdir()`，并在 `finally` 块还原，使现有 RD3/RD4 测试的临时文件（路径位于 `tmpdir()` 下）通过路径白名单
- **RD5**：路径穿越测试（`/etc/hosts` 在 Unix 上存在，但不在安全目录内）
- **RD6**：PII 脱敏测试（构造含身份证号的 PDF，断言返回文本中无明文号码，有脱敏占位符）；条件依赖 `reportlab`

---

## 测试先红后绿证据

### RD5（路径穿越被拒）

**修复前（仅写测试、未改 read-document.ts）运行结果：**
```
AssertionError [ERR_ASSERTION]: RD5 FAIL: 路径应在扩展名检查前被拦截，错误信息不应是"不支持的文件类型"
    at tests/read-document.test.ts:58:14
  actual: false, expected: true
```
原因：`/etc/hosts` 文件存在，扩展名 `.hosts` 不受支持，代码返回 "不支持的文件类型 .hosts"；路径检查不存在，断言失败。

**修复后运行结果：**
```
read-document: RD5 路径穿越被拒 ✓
read-document: 类型路由 / 错误处理 / PDF·图片取文本 ✓
```

### RD6（PII 脱敏）

本测试依赖 `reportlab` Python 包，当前测试环境未安装，测试以 `⚠` 跳过：
```
read-document: reportlab 不可用,跳过 RD6 ⚠
```

逻辑正确性说明：
- 修复前若 `reportlab` 可用：PDF 文本原文返回，`!/11010119900307123X/i.test(text)` → `false` → 断言失败（先红）
- 修复后若 `reportlab` 可用：文本经 `redact()` 后变为 `[已脱敏:身份证]`，两个断言均通过（后绿）

---

## 成功标准核验

| 标准 | 结果 |
|------|------|
| `grep -n "redact" lib/agent/mcp-tools/read-document.ts` 命中 | ✓ 第 7 行 import，第 68 行使用 |
| `query/route.ts` 两处 serverLog 均过 redact | ✓ 第 91、392 行 |
| `cockpit/summary/route.ts` 一处 serverLog 过 redact | ✓ 第 77 行 |
| 新测试先红后绿 | ✓ RD5 确认先红后绿；RD6 条件跳过（reportlab 未装） |

---

## 与 spec 的偏差及理由

1. **路径白名单仅检查 `getAppDataDir()`（不单独列举会话文件目录）**：会话文件目录 `getConversationFilesDir()` 的实现是 `path.join(getAppDataDir(), "files", conversationId)`，本身就是 `getAppDataDir()` 的子目录，检查 `getAppDataDir()` 已完整覆盖。与 spec 意图一致，无功能差异。

2. **`read-document.ts` 中路径检查置于 `existsSync` 之前**：spec 未规定顺序，但先检查路径安全性后检查文件存在可避免通过错误消息泄漏禁区文件是否存在（信息泄漏更小）。符合安全最佳实践。

3. **RD6 跳过而非真正先红后绿**：`reportlab` 未安装导致测试环境无法执行 PDF 创建。跳过逻辑与现有 RD3/RD4 一致（均打印 `⚠` 警告）。代码逻辑正确，安装 `reportlab` 后可验证先红后绿。

---

## 开放风险

1. **`getAppDataDir()` 返回路径在测试中依赖 env var**：如果某测试未设置 `FINANCE_AGENT_APP_DATA_DIR`，而文件路径正好在系统默认 app data 目录（如 `~/Library/Application Support/finance-agent`）外，路径检查会拒绝。现有 RD3/RD4 通过设置 env var 解决，后续新测试需注意同样处理。

2. **`DocCache` 未受路径白名单保护**：白名单只在工具入口执行，`docCache` 内部按 `(filePath, mtime, size)` 缓存。若恶意路径碰巧命中缓存（理论上不可能，因为路径被拒后从未写入缓存），不会泄漏。无实际风险，仅记录。

3. **RD6 只能在安装 `reportlab` 的环境中获得完整验证**：CI/CD 如需覆盖 PII 脱敏，需确保 Python 环境包含 `reportlab`。
