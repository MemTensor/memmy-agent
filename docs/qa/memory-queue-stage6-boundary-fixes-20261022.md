# Memory 队列阶段 6：开关、事件循环与 Provider 边界补修

日期：2026-10-22。基线 `23efb8bd`，分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`。本轮仅修复已确认的 3 项，补回归并重新审查；不进入下一阶段，不生成 DMG、不推送、不提交 PR。

## 复现与修复

### 运行中关闭记忆写入

真实 MemoryService、SQLite、配置 reload 与受控摘要模型，首条请求挂起后关闭 `algorithm.enableMemoryAdd`。修前 continuous 仍处理完 8 条；原有限批次完成 4 条后，下个入口才停止。证明持续运行绕过了原先每个入口的开关检查。

现在每轮准入前、预算准备步骤返回后及当前领取波次启动后都检查开关，关闭后不再取得新任务租约，已经准入的任务可以收尾。retry-only 入口关闭时直接返回空执行结果。配置 reload 无论是否请求恢复失败任务都会唤醒当前 pump，避免它等待无关 Provider 释放后才看到开关变化。

真实配置回归使用单逻辑槽位：关闭后仅首条已准入摘要完成，其余 7 条仍 queued，attempts、leaseCount 为 0，token 为空；重新开启后，新一轮正常处理这些记录。另覆盖等待 `beforeRun` 时关闭，以及短任务链中由定时回调关闭。

### 快速任务连续补位阻塞事件循环

修前真实 SQLite 与 WorkerRunner 的 200 条短数据库任务全部完成后，预先安排的 0ms 取消回调才运行，单次记录约 531ms；纯 Promise 微任务链没有把机会交给定时器与 HTTP。外层 HTTP 的让步位于整次 continuous 返回之后，不能保护执行中的长任务链。

现在每累计领取 32 条逻辑工作，在下一轮准入前通过原生 `node:timers/promises.setImmediate()` 让出一个事件循环机会；已经领取的工作立即启动，不为了让步预领取后等待。让步结束后回到循环顶部，重新检查写入开关、取消、停止和等待的手动请求。

32 是让步频率，不是并发上限、任务总预算或毫秒响应承诺。任务自身的同步耗时不在此机制中被抢占。默认全局 4、本地 1、云 2、Embedding 请求 1 不变；有限手动请求仍保留其预算与目标过滤。测试允许 timers/check 阶段顺序差异，不要求取消恰好发生在第 32 条。

### Mistral 跨协议服务限额

真实聊天客户端、原生 Mistral Embedder、Router、Controller，只有网络响应使用受控替身。修前 2 个 `/v1/chat/completions` 与 1 个 `/v1/embeddings` 同时进入同一 Mistral API 服务，峰值 3 超过云限额 2。

现在原生 Mistral 的末尾 `/embeddings` 按该服务的 API base 归一化，与兼容聊天共享 Provider 根；保留主机及前面的代理路径，不把不同主机或不同租户 base path 合并。覆盖默认、显式端点和代理路径隔离；之前的 Anthropic 及前台/worker 上下文回归仍保留。

## 修前证据与验证范围

- 写入开关原复现：`/private/tmp/memmy-stage6-continuous-capability-review.log`；正式开关回归修前 4 项均失败：`/private/tmp/memmy-stage6-capability-reload-before.log`。
- 事件循环原复现：`/private/tmp/memmy-stage6-continuous-abort-yield.repro.log`。
- 正式事件循环回归的独立基线副本：`/private/tmp/memmy-stage6-eventloop-baseline.log`，6 项修前全部失败；当前新增 6 项和原连续调度 33 项共 39 项通过：`/private/tmp/memmy-stage6-eventloop-after.log`。
- 关闭时唤醒 Provider 等待的单独对照：`/private/tmp/memmy-stage6-capability-notify-before.log`。仅在临时副本删除 reload 的通知行，该场景失败；当前正式开关文件 5 项全部通过。
- Mistral 原复现：`/private/tmp/memmy-provider-audit.log`；正式回归修前 3 项均失败：`/private/tmp/memmy-stage6-mistral-before.log`。

修前对照及新测试使用隔离的临时数据库、当前源码与基线的临时加载/副本，没有回滚工作树。未接入当前桌面用户数据，没有外部模型调用或 DMG 安装测试。

## 最终验证与复查

本轮新增 14 项正式回归：写入开关与重载 5 项、事件循环机会及清理 6 项、Mistral 归一化 3 项。事件循环测试同时检查：

- 0ms 取消、停止、手动请求能在 200 条短任务清空前生效；未领取记录保持 attempts 为 0、token 为空。
- 跨宏任务补位后，全局峰值仍为 4、同一个 Provider 峰值仍为 2。
- 异常与取消前确实创建了相关 deadline/heartbeat 定时器；完成后定时器、许可全部归零。
- 配置关闭后重启一轮可以继续处理原排队记录，没有人为消耗重试次数。

代码冻结后，在 macOS arm64、Node.js 22.23.3、npm 10.9.9 下检查：

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| Memory 全量 | 1664 通过、1 跳过；167 个文件通过、1 跳过 | `/private/tmp/memmy-stage6-boundary3-memory-full.log` |
| Memory 服务与 viewer 类型检查 | 通过 | `/private/tmp/memmy-stage6-boundary3-typecheck-final.log` |
| 后端全量 | 1085 通过，132 个文件通过 | `/private/tmp/memmy-stage6-boundary3-backend-full.log` |
| 后端类型检查 | 通过 | `/private/tmp/memmy-stage6-boundary3-backend-typecheck.log` |
| release workflow 保护 | 30 通过、5 跳过 | `/private/tmp/memmy-stage6-boundary3-release.log` |
| packaging guards 最终重跑 | 122 通过、1 跳过 | `/private/tmp/memmy-stage6-boundary3-packaging-final.log` |
| 差异检查 | 通过 | `git diff --check` |

首次 packaging guards 有 2 项 `packaged-runtime-config.test.mjs` 失败（Windows History recorder 正常夹具的退出状态、Windows 分隔符夹具的 ASAR JSON 读取），其余 120 项通过、1 跳过。未更改源码、测试或检查规则，随后该文件 29 项单独通过，完整保护重跑 122 项通过、1 跳过。原因尚未确认，不把首次失败隐去，也不将其归因为已经确定的 CPU 或环境问题。首次日志 `/private/tmp/memmy-stage6-boundary3-packaging.log`、单独复核 `/private/tmp/memmy-stage6-boundary3-packaging-recheck.log` 均保留；未因该次失败扩大本轮修改范围。

独立交叉复查已检查 Provider 服务根隔离、动态开关与重载唤醒、宏任务让步位置、准入前重新检查状态、已开始任务收尾以及异常与取消的许可/定时器清理。本轮 3 项没有遗留未处理的复现场景；既有补位、FIFO/WRR、公平性、预算与租约语义由相应回归继续验证。

完整前端与 Agent 工作区回归、真实模型负载和 macOS 安装测试仍留在后续统一验证阶段。此处没有执行整个 monorepo 的 `npm test`，没有生成或安装 DMG，也没有 Windows 实机验证。
