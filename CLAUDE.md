# CLAUDE.md

## UIUX前端设计

参考 app/globals.css，最好围绕token设计。间距节奏、交互态、界面文案约定见 `docs/ui-conventions.md`。

**涉及界面的改动必须截图验证**：改完后启动开发服务器，在浏览器里实际打开改动页面截图确认，不能只凭测试绿或代码审查判断视觉效果是否正确。

## Worktree 依赖管理

**创建 worktree 时不要全量安装依赖**：优先把本地主分支（或已装好依赖的其它 worktree）的 `node_modules` 软链接过来，不要在每个 worktree 里各自跑一次完整安装。若该 worktree 的依赖版本与主分支有差异，只对有差异的包做增量安装/更新；也可以先在本地装好完整依赖后再整体软链接进来。目标是不让每个 worktree 都各自占一份完整的 `node_modules`。

**worktree 的 PR 合并后要清理**：确认 PR 已成功合并、该 worktree 没有其它未合并的改动后，清理其中的构建产物（如 `.next`、`dist`）和该 worktree 独立安装的依赖产物，不要让废弃的 worktree 继续占着磁盘空间。

## CodeGraph

This project uses CodeGraph for local code intelligence. The index lives in the ignored `.codegraph/` directory and is recreated with `codegraph init .` when needed.

Rules:
- For codebase questions, first run `codegraph explore "<question>"` when `.codegraph/` exists. Use `codegraph node "<symbol>"`, `codegraph callers "<symbol>"`, `codegraph callees "<symbol>"`, or `codegraph impact "<symbol>"` for focused source and relationship tracing.
- Prefer the indexed source and call paths, but verify important conclusions against the current source. Treat dynamic dispatch and documentation-only relationships as hypotheses until confirmed.
- Use `codegraph status` to check index freshness and `codegraph sync .` after modifying code. Use `codegraph init .` only when the index is missing or needs a clean rebuild.
- Do not use the retired Graphify workflow or recreate `graphify-out/` in this repository.
