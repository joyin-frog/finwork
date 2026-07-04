# Issue tracker: GitHub

本仓库的问题与 PRD 使用 `joyin-frog/finwork` 的 GitHub Issues 管理。所有操作通过 `gh` CLI 完成。

## 约定

- 创建：`gh issue create --title "..." --body "..."`
- 查看：`gh issue view <number> --comments`
- 列表：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

在仓库 clone 内执行时由 `gh` 从 git remote 推断仓库。

当技能要求“publish to the issue tracker”时，创建 GitHub Issue；要求“fetch the relevant ticket”时，使用 `gh issue view <number> --comments`。
