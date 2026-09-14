# GitHub Issue 到云效同步

这个仓库使用 GitHub Actions 直接调用云效 OpenAPI，把 GitHub Issue 和 Pull Request 映射成云效工作项。`coding agent` 继续负责开发任务、分支和 PR，不参与这条 CRUD 同步链路。

同步链路如下：

```text
GitHub issues / external pull_request_target
  -> .github/workflows/yunxiao-github-sync.yml
  -> scripts/yunxiao_github_sync.py
  -> 云效 OpenAPI
  -> 目标空间（project）/目录（parentId）中的工作项
```

## 仓库配置

在每个 GitHub 源仓库的 `Settings -> Secrets and variables -> Actions` 中配置：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `YUNXIAO_TOKEN` | Secret | 云效 PAT，只授予目标空间的工作项读写权限 |
| `YUNXIAO_PROJECT_ID` | Variable | 目标云效空间/项目 ID |
| `YUNXIAO_PROJECT_NAME` | Variable | 目标空间/项目名称，用于预检 |
| `YUNXIAO_PARENT_ID` | Variable | 目标目录对应的父工作项 ID；没有目录时留空 |
| `YUNXIAO_SPRINT_ID` | Variable | 目标迭代 ID。云效 API 将迭代字段称为 `sprint`；默认使用 `待定`（`1b60d4a7ac4f79a141c76141c1`） |
| `YUNXIAO_DEFAULT_ASSIGNEE_NAME` | Variable | 可选，默认负责人姓名；留空则不自动分配负责人 |
| `YUNXIAO_PARTICIPANT_NAMES` | Variable | 参与者姓名，英文逗号分隔；默认 `徐之淇,贾澄臻` |
| `YUNXIAO_WORKITEM_CATEGORY` | Variable | 工作项大类，默认 `Req` |
| `YUNXIAO_WORKITEM_TYPE_NAME` | Variable | 工作项类型名称，默认 `需求` |
| `YUNXIAO_PRIORITY_NAME` | Variable | 默认优先级，默认 `中` |
| `YUNXIAO_DAYS_TO_FINISH` | Variable | 计划完成时间距创建时间的天数，默认 `7` |
| `YUNXIAO_API_BASE_URL` | Variable | 可选，默认 `https://openapi-rdc.aliyuncs.com` |

`memmy-agent` 默认使用云效项目 `memmy`，项目 ID 为
`1832b179386e24414d3891e244`。该默认值已经写入 workflow；如果仓库 Variables
中配置了同名变量，则以 Variables 为准。

`YUNXIAO_DEFAULT_ASSIGNEE_NAME` 可以暂时留空。这样工作项仍会进入
`memmy` 需求空间，由云效用户后续人工分配负责人。

`memmy` 空间的需求工作项要求填写迭代，默认使用“待定”。如需改用其他迭代，配置
`YUNXIAO_SPRINT_ID`。迭代 ID 可以从云效迭代页面 URL 获取，例如
`/sprint/<迭代 ID>`；迭代名称（如 `v1.1.5`）不是 API 接受的值。

预检会按语义解析云效工作流状态：合并的 PR 优先使用“已完成”，如果目标项目
使用“开发完成”则自动使用该名称；取消状态同理支持“已取消”“已关闭”“关闭”。

每个源仓库可以使用不同的 `YUNXIAO_PROJECT_ID` 和 `YUNXIAO_PARENT_ID`。例如：

| GitHub 仓库 | 云效空间 | 云效目录 |
| --- | --- | --- |
| `MemTensor/memmy-agent` | `memmy` (`1832b179386e24414d3891e244`) | 留空，直接进入需求空间 |
| `MemTensor/MemOS` | MemOS 开源项目管理 | MemOS 目录 |
| `MemTensor/MemOS-Cloud-CLI` | CLI 项目 | CLI 目录 |

你提供的页面 URL 中 `viewIdentifier=d7f112f9d023e2108fa1b0d8` 是云效“需求”列表视图标识，
不是创建工作项 API 的 `parentId`。当前需求是写入 `memmy` 空间，因此
`YUNXIAO_PARENT_ID` 应保持为空。只有确认了一个真实的父工作项/目录 ID 后，才配置
`YUNXIAO_PARENT_ID`。

如果云效页面中的“目录”只是列表视图，而不是父工作项，应改为配置不同的
`YUNXIAO_PROJECT_ID` 或保持 `YUNXIAO_PARENT_ID` 为空。

## 运行方式

第一次接入按以下顺序运行 `Sync GitHub to Yunxiao`：

1. `mode=preflight`：只检查 Token、空间、工作项类型、状态、优先级和负责人。
2. `mode=backfill`、`state=open`、`apply=false`：查看回填 dry-run 结果。
3. 确认结果后再次运行 `mode=backfill`、`state=open`、`apply=true`。
4. 需要把历史关闭项也纳入同步时，将 `state` 设为 `all`。

实时事件会处理 `opened`、`closed` 和 `reopened`。Pull Request 使用 GitHub 的
`author_association` 判断来源，只同步社区身份 `CONTRIBUTOR`、`FIRST_TIMER`、
`FIRST_TIME_CONTRIBUTOR` 和 `NONE`；仓库内部的 `OWNER`、`MEMBER`、
`COLLABORATOR` 以及未知身份会跳过。Issue 不做这个过滤。

已存在的云效工作项只更新状态，不重复创建。历史回填也会沿用同一条 PR 过滤规则，
不会把内部 PR 新建到云效。已经存在的内部 PR 工作项不会被自动删除。

幂等键包含完整源仓库名，例如：

```text
[GitHub MemTensor/memmy-agent Issue #123]
```

因此不同仓库即使使用相同的 Issue 编号，也不会互相覆盖。Issue 标题、链接、正文和 GitHub labels 会写入新建工作项；评论暂不同步。

其他 GitHub 仓库接入时复制这个 workflow 和脚本，再为该仓库设置自己的 Variables/Secret 即可。仓库数量继续增长后，可以把脚本移动到同组织的私有 reusable workflow 仓库，源仓库只保留一个调用文件，映射仍由各源仓库自己的 Variables 管理。
