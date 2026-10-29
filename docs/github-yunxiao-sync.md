# GitHub → 云效标题同步

`Sync GitHub to Yunxiao` 工作流将 GitHub Issue 和社区 PR 同步到仓库变量指定的云效项目。

卡片标题使用短格式：

- `[Issue #594] 原始 Issue 标题`
- `[PR #766] 原始 PR 标题`

卡片描述首行保留 `GitHub: https://github.com/owner/repository/issues/594`（PR 使用
`/pull/766`）。这条来源链接用于区分仓库、类型和编号，请保留该行。
脚本兼容原先的 `[GitHub owner/repository Issue #594]` 和 `[GitHub Issue #594]`
标题；后续生命周期事件会复用已有卡片、缩短前缀并保留当前标题正文。来源缺失或同一来源对应多张卡片时，
同步会报错，避免误改或重复创建。

## 整理已有卡片标题

在 GitHub Actions 中打开 `Sync GitHub to Yunxiao`，选择 **Run workflow**：

1. `mode` 选择 `rename-titles`，`apply` 保持关闭，先检查运行日志中的预览统计。
2. 确认 `failed=0` 和 `would_rename` 数量后，再运行相同模式并勾选 `apply`。
3. 检查 `renamed`、`skipped`、`failed` 统计，并回查云效列表。

该模式只整理目标云效项目中已存在、来源匹配当前 GitHub 仓库的卡片（含已关闭项），
仅写入 `subject`。不会创建历史卡片，也不会修改状态、迭代、负责人、参与者或描述。
`state` 选项只用于 `backfill`，不限制标题整理范围。
整理重复执行不会再次改写已经使用短标题的卡片；写前回读发现标题或来源变更时会跳过并报错，
应重新预览后再处理。回读与写入之间仍有短暂竞争窗口，整理期间请避免同时编辑卡片标题。

本地对应命令（需要安全注入既有云效凭据和仓库映射变量）：

```sh
python scripts/yunxiao_github_sync.py --mode rename-titles --dry-run
python scripts/yunxiao_github_sync.py --mode rename-titles --apply
```

`--dry-run` 优先于 `--apply`。只为改标题时不要使用 `backfill --state all --apply`，
它会同步状态和人员等字段，并可能创建此前未同步的历史工作项。

云效 API 参考：[搜索工作项](https://help.aliyun.com/zh/yunxiao/developer-reference/searchworkitems)、
[更新工作项](https://help.aliyun.com/zh/yunxiao/developer-reference/updateworkitem)。
