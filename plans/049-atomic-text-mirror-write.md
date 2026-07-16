# Plan 049: writeTextMirror 改原子写（tmp + rename），杜绝崩溃后半截文本镜像

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- lib/knowledge/storage.ts tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

知识库的正文文本镜像（ripgrep 全文检索与语义检索的数据源）用裸 `writeFileSync` 写盘。进程在写大文档中途崩溃/被杀会留下半截 `.txt`；`readTextMirror` 只查 `existsSync`，半截文件照常通过，检索从此静默返回残缺内容且无自愈手段（除非重新摄入）。同文件的 `writeUploadedFile` 已经有 tmp + link 的原子模式，`writeTextMirror` 是唯一漏掉的写入点。

## Current state

- `lib/knowledge/storage.ts:90-96`（原样摘录）：

```ts
export function writeTextMirror(hash: string, text: string): string {
  const dir = getKnowledgeTextDir();
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.txt`);
  writeFileSync(filePath, text, "utf-8");
  return filePath;
}
```

- 同文件 67–88 行 `writeUploadedFile` 的原子模式（tmp 带 `randomUUID()` 后缀、`{flag:"wx"}`、finally 清 tmp）——本计划复用其风格，但用 `renameSync` 而非 `linkSync`：镜像文件**允许覆盖**（重新摄入同 hash 时更新），`rename` 在同目录下原子且天然覆盖，`link` 会 EEXIST。
- `randomUUID` 已在该文件 import（供 `writeUploadedFile` 使用，核对 import 行确认）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |

## Scope

**In scope**:
- `lib/knowledge/storage.ts`（仅 `writeTextMirror` 函数体）
- 知识库存储既有测试文件（`grep -rn "writeTextMirror\|storage" tests/ | head` 定位；若无既有存储测试则在 `tests/` 按现有组织新增）

**Out of scope**:
- `writeUploadedFile` / `readTextMirror` / `deleteTextMirror` / lease registry。
- 半截文件的「检测/修复」逻辑（防新增即可，历史坏文件不在本计划内）。

## Git workflow

- Branch: `advisor/049-atomic-text-mirror`
- Commit：`fix(knowledge): 文本镜像改原子写（tmp+rename）`
- 不 push、不开 PR。

## Steps

### Step 1: 改写函数体

```ts
export function writeTextMirror(hash: string, text: string): string {
  const dir = getKnowledgeTextDir();
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.txt`);
  const tmpPath = path.join(dir, `.${hash}.txt.write-${randomUUID()}`);
  writeFileSync(tmpPath, text, { encoding: "utf-8", flag: "wx" });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}
```

`renameSync`/`rmSync` 若未 import，从 `node:fs` 追加。

**Verify**: `npm run typecheck` → exit 0

### Step 2: 测试

两例：
- 正常写后 `readTextMirror(hash)` 返回全文，目录内无 `.write-` 残留 tmp。
- 覆盖写（同 hash 写两次不同内容）返回第二次内容。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`

## Test plan

见 Step 2；测试的 appdata 目录初始化方式仿照 tests/ 中现有 knowledge/storage 相关用例（若无，则仿照任一使用临时 `FINANCE_AGENT_APP_DATA_DIR` 的用例）。

## Done criteria

- [ ] `writeTextMirror` 无裸 `writeFileSync(filePath, ...)`（`grep -n 'writeFileSync(filePath' lib/knowledge/storage.ts` 无命中）
- [ ] 新测试 2 例 pass；typecheck 全绿
- [ ] `git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 现有代码与摘录不符（漂移）。
- 发现 `getKnowledgeTextDir()` 与 tmp 可能跨文件系统（rename 非原子）——本仓库两者同目录，不应发生；若发生即报告。

## Maintenance notes

- 若将来给镜像加校验（hash of text），写侧在此函数追加；读侧 `readTextMirror` 相应校验。
- Reviewer 看点：`wx` flag 防 tmp 撞名；失败路径 tmp 必清。
