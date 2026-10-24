# Windows History 采集与证据连续性修复

日期：2026-10-16（Asia/Shanghai）。本轮只交付本地代码提交，整体集成和安装包由发布任务负责。

## 分支与范围

- 分支：`codex/windows-history-evidence-repair-20261015`
- 基线：`6e3d38f17`（`fix(history): retain native browser windows and unidentified input`）
- 修改：Windows 原生 History helper、共用采集消费/健康状态、摘要与长期证据保留、History skill，以及相关回归。
- 原主工作区的 WeChat 修改未纳入；Excel 工具、读写逻辑、专用说明均无改动。
- 未 push、合并或生成安装包，未替换 VM 已安装版本。

## 已确认的故障链

10 月 15 日通过 SSH 检查 Windows 11 ARM VM 中指定的 Memmy 会话及原始记录。复制时共 1,031 条事件，其中没有任何 `accessibility_snapshot`，也没有携带 `ax` 的事件；点击目标均未知，但当时状态仍报告 healthy。输入计数与应用切换仍工作，不能据此认为窗口内容采集正常，也不能由点击数推算实际漏采率。

安装版本为 1.2.3。此前已对安装包提取的 32 个 History JS 文件与基线编译结果比对一致；安装 helper 的 SHA-256 为 `698fee33bf6e97d8d78ec89dcc2913732556b34af4372ad75a9d9775f544cee6`，worker 源码 SHA-256 为 `b3e6eff8bf79e9eef7d29a871d51c0b651a52806dc0432334020271f14c02646`。正在运行的 worker 与该源码加 BOM 一致。因此，这次故障不能归为漏装此前 History 修复。

`worker.ps1` 的真实 `Snapshot` 返回路径将 `Generic.List[object]` 写成 `@($targets)`。VM 的 Windows PowerShell 5.1.26100.9711 对空列表和非空列表均抛出 `System.ArgumentException: Argument types do not match`。全量 UIA 树因此失败，局部动作路径仍成功。旧 Go 健康逻辑把局部成功当作 observer 恢复，Node 又只依据心跳/事件输出判断状态，隐藏了内容采集故障。

10 月 16 日再次在同一 VM 运行纯内存 fixture：恢复旧返回表达式时，真实 `Snapshot` 函数在返回处失败；改用 `$targets.ToArray()` 后，空/非空目标与真实树遍历测试均成功。测试未访问桌面。

原记录没有保存关键控件/操作证据，不能靠修复代码补回过去事实，也不能据此确认操作者或业务结果。

## 系统性改动

### 采集与质量

- 修复 PowerShell 集合转换，SelfTest 直接覆盖真实 Snapshot 遍历和返回路径，而非只测孤立表达式。
- 全量树携带 `truncated`、`readFailures`；节点/兄弟/时间/总字数和单字段裁剪均如实标记部分采集。
- 全量树始终交由 Node 按当前授权持久化、去重。相同文本的质量恢复、排除后重新允许，不再被 native 同文去重吞掉。
- `snapshotDeferred` 区分合法节流与失败；worker 自行升级为全量读取后失败也能报告。
- 维持已有采集预算、读频率、输入合并、进程截止时间与终止机制。

### 真实健康状态与缺口

- `ax_snapshot_failed` 独立于心跳和动作记录。局部动作、observer_ready 和时间流逝均不能清除它。
- 只有 Node 授权并落盘完整非空树，或确认与已落盘基线一致，才发出 `ax_snapshot_ready`；Windows 必须显式提供 `truncated=false`、`readFailures=0`。旧质量未知树仍保留内容，但不声称采集恢复。
- 将内容无关的健康信号写入历史，后续可区分当时的限制与当前状态。落盘失败直接停止，避免向同一失败文件递归报告。
- 无法安全关联上下文的输入保留 `capture_gap`：原输入时间、有限动作类型/按钮/计数/原因，无坐标、按键、应用、URL 或文本。密码与同意边界仍按原规则跳过。
- 只有缺口或失败的片段也会被检索、摘要和保留，避免过期后被当作“无活动”删除。

### 操作语义与隐私连续性

- 确认点击目标仍需原有 runtime ID、窗口、页面、时效与内容代数证明。
- 最多保留 3 个此前同位置控件，单独标记 `previously_observed_not_confirmed_target`，供模型作有条件推断。它们不等于点击目标、操作者或成功结果。
- 候选时间必须匹配 Node 此前授权全量树的 `ax.observedAt`，并匹配窗口；排除/未知来源/配置变化会撤销证明。落盘前再次检查配置代数，排除期间的 native 缓存不能流入允许后的记录。
- 焦点/窗口标识的局部 envelope 不再擦除已授权树基线；质量变化即使文字相同也保留完整证据。

### 摘要、长期保留与模型读取

- 模型证据包含实际 AX 数量、空/部分/质量未知、full/diff 与缺失基线、失败/恢复时间及输入缺口，仍受 12,000 字符与现有 token 预算约束。
- 长期证据新增逐条 `recorded_action`，保留时间、sequence、重复操作、未知目标与浏览器 actor/phase/interactionId/前后状态，避免聚合后丢失操作顺序。
- 浏览器状态的有序 `string[]` 文本得到保留，控件/状态统一安全字段投影，剔除未知字段与敏感值。
- Skill 明确 raw `ax.text`、连续基线、UTC/内容内部时间、Windows UTF-8 读取与证据边界；详细问题允许追查 active/相邻片段。
- 分析由事实证据和问题决定，不为特定按钮或业务场景写结论模板。长期语义证据不等于完整原始 AX 树，不能在 raw 过期后宣称完整重建屏幕。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Agent History 全套 + skills-loader，59 文件 | 726 通过，4 跳过 |
| History contract + packaging，2 文件 | 24 通过，1 跳过 |
| Agent `tsc -p tsconfig.json --noEmit` | 通过 |
| Go `test -race ./...`、`vet ./...` | 通过 |
| Windows amd64 / arm64 helper 编译 | 通过 |
| VM PS 5.1 新 worker `-SelfTest` | 通过，真实 Snapshot 内存 fixture |
| 同 fixture 旧 `@($targets)` 对照 | 预期失败，在 Snapshot 返回处复现 ArgumentException |
| 空/非空列表独立对照 | 旧表达式均失败；ToArray 分别返回 0 / 1 个目标 |
| VM amd64 / arm64 helper `--self-test` | 均通过，desktopAccess=false |
| VM 两架构纯 Go tests | 每架构 24 个顶层测试及 7 个 failure 子用例通过 |
| 最新 candidate 同文基线刷新/排除重授权/落盘前配置变更回归 | 11 项 targeted 测试通过 |
| 独立只读审查 | 发现的候选历史授权问题已修复，复审无新增实质问题 |
| `git diff --check` | 通过 |

Agent 的 4 项跳过为现有平台条件测试；packaging 的 1 项跳过依赖本工作区未生成的 Windows dist helper。Electron 测试以 `ELECTRON_RUN_AS_NODE=1` 运行，不启动 GUI。初次 packaging 检查因隔离工作区缺 Electron 路径失败，补接已有依赖后重跑通过；无产品代码绕过。

原始纯测结果保存在本机 `/tmp/memmy-win-history-final-pure-20261016/`；旁边的 `windows-history-evidence-repair-20261016.json` 保存可提交的脱敏结果和源码/测试文件哈希。VM 专用测试目录已清理。私人的会话正文和原始活动记录不入库。

## 集成与用户验收

1. 集成本分支提交时保留发布分支已有改动；同时合入 native worker/Go 与 Node/skill，不能只替换 JS。按最终集成提交重建 helper，检查 Windows amd64/arm64 路径及打包哈希，避免复用旧 helper。
2. 用户在最终 Windows 安装版中完成普通页面/文档的连续活动：点击、快速跳转、滚动、输入与切换，检查原始流出现可读全量/增量树和对应质量；未知点击不能被新页面控件冒名。
3. 检查失败时 degraded、只有完整树才恢复；对较大窗口触发的 partial 应保留事实，不伪装 healthy。现有 400 节点、24 兄弟、字段长度等预算可能使复杂窗口持续 partial。
4. 排除某应用/网站后再允许，确认不回流排除期间旧树/候选；确认密码与 WeChat 同意边界。用一组重复且不同的操作验证长期摘要仍能恢复其先后次序。
5. 用户用详细时间线/具体动作问题验收：回答应引用观测时间、区分直接证据与推断，缺失证据不归责给用户。共享 Node 改动还需 macOS 安装版回归。

本轮证明源码修复、纯 Windows 运行与自动化回归，不证明最终安装包的现场采集覆盖、延迟、CPU/电量或 GUI 验收。兼容浏览器扩展提供的语义 History 仍有其连接/能力边界；本轮没有新增 CDP/内置浏览器语义录制通道。原始证据缺失的过去时间段无法恢复。
