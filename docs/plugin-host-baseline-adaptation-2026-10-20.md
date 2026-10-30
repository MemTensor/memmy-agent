# 插件 Host 基线适配记录

## 来源与边界

本分支 `codex/teach-mode-host-baseline` 直接从 `ad88234a2f003aa5e47ebe5350a6ee3082039c30` 建立，保留原工作区。Host 候选版本为 `1.2.3-rc.8`。Teach Mode `0.3.0` 在独立 Git 仓库 `/home/zephyr/work/teach-mode`，沿用 memmy-plugins 单插件目录及 MPP ZIP 布局；不进入 Host 安装包。每个插件使用各自的远端仓库。

Host 只加入通用协议、生命周期、共享采集、状态展示和生成技能管理。教学编排、提示文案、网页操作、Notepad 适配、旧版执行器、迁移与业务测试在插件仓库。现有 Skill Creator 仍由 Host 提供，插件调用其指令与校验器，生成成功和试运行成功分别报告。

## 与指定基线的接口差异

| 位置 | 增量适配 | 保留的基线行为 |
| --- | --- | --- |
| createBackendServices | 加入原生服务路由、动态技能、采集租约、启动/关闭和更新生命周期 | 账号、requiredEntitlement、modelPolicy、模型/嵌入、ASR、asset-key、Registry 认证、输入根目录及 workspace |
| 清单 | 可选 description/platforms/minimumHostVersion/installMode/updateMode/conversation/requiredHostCapabilities；按需隐藏 agent 工具 | agentSkillId、pinned、topbar、surface 及既有插件默认值 |
| MCP stdio | Windows 官方原生插件、宿主 Node、常驻进程、优雅关闭、异常通知、反向 memmy/host-service | 普通本地插件默认沙箱及账号策略，远程 MCP/SSE/HTTP、secret header 与网络权限 |
| 原生信任 | Registry 可信来源、下载校验后的 SHA-256、用户 native-execution 授权同时成立 | 账号登录资格与 entitlement 另行校验；Registry 自称 nativeExecutionAllowed 不足以获得资格 |
| Host 服务 | 真实插件身份，活动调用/对话身份及模型选择；事件不能伪造 conversationId | 原有模型、ASR、asset-key 路由 |
| 数据库 | 仅新增 0032-plugin-native-trust.sql 的两列 | 0026/0027 保持原文和历史；旧未发布 0030 原型在结构确认后识别，不重复建表 |
| 采集 | 订阅现有 Computer History；用户后台意图独立保存；与旧任务录制共享互斥；原生输入队列、归一化、落盘关联 checkpoint | 现有授权、后台摘要、轮转和用户运行/暂停/停止意图 |
| 技能 | app-data/plugin-skills/active.json，按 owner 注册；文件/证据哈希、工具依赖、重名、撤下/恢复 | 工作区与内置技能优先级，包内静态技能继续用 workspace/skills 和 .memmy-plugin-owner.json |
| 对话 | /teach 经现有 Agent 技能入口；通用状态条显示插件提供的提示与操作；后台状态查询不产生对话卡片 | 基线 pinned/topbar、能力事件、surface、其他命令路由 |
| 更新 | 启动及每六小时；任务租约推迟切换；失败回滚、新权限重新确认 | 首次手动安装、主动停用状态和用户数据保留 |

Agent 的原生采集所有者每三秒由 Backend 续约；Backend 退出且三十秒无心跳后释放租约、将中断任务标为失败。插件退出、停用、卸载与正常应用关闭主动清理。反向调用启动回执丢失时，也按插件身份清理实际 Agent 资源。

片段时间范围以用户开始/结束请求为准，结束固定事件字节范围、快照及 SHA-256。采集器不健康、checkpoint 超时或无法确认完整性时标为部分可用，不伪造完整证据。关闭片段不触发生成；生成不触发执行。

## 独立构建与验证入口

主仓库 CI `.github/workflows/plugin-host-compatibility.yml` 在 Linux、Windows 独立检出运行通用检查，不读取 Teach Mode 源码。插件仓库独立运行构建/测试。Host 制品工具：

```sh
npm ci --legacy-peer-deps
npm --prefix App/memmy-agent ci --legacy-peer-deps
npm run typecheck -w @memmy/backend
npm run typecheck -w @memmy/frontend-desktop
npm --prefix App/memmy-agent run build
node scripts/plugin-host/build-conformance-kit.mjs /tmp/plugin-host-kit
```

Windows 打包额外用 MSVC/CMake 构建共享原生任务录制器，并在 staging/unpacked 检查可执行文件与哈希。正式 Host kit 由 release.published 流程读取 GitHub 实际标签和发布记录生成；开发 kit 的 release 为 null。插件发布据此生成最低 Host 版本，并继续探测运行时能力。

正式发布兼容检查通过后，流水线将 Host kit 及校验文件附加到该 GitHub Release，下载文件名增加 linux-x64 / win32-x64 后缀。插件 CI 直接消费对应平台的 ZIP URL 与 SHA-256，不依赖临时 Actions 制品的外层包装。

截至本地验证：

| 检查 | 结果与实际范围 |
| --- | --- |
| Backend 插件回归 | 29 文件，171 通过、1 跳过；覆盖基线服务、沙箱/远程 MCP、权限、文件、账号、迁移、技能与更新 |
| 共享 History 与 Agent 技能 | 扩大回归 614 通过、17 跳过；2 项微信平台测试失败。已换回 pristine ad88234a 的 History 源码，复现相同两项失败 |
| 插件 UI | 135 通过、3 跳过；既有 surface、设置、API、ASR 与新商店、状态条。HomePage 全套另有 11 项既有断言失败，pristine 基线复现相同 11 项 |
| 协议与包装 | 109 通过、2 跳过；清单 Schema、包版本、原生依赖及不夹带插件源码 |
| 构建 | Backend 类型检查、生产 Agent 和渲染器构建通过；渲染器使用 .env.example 的公开 legal origins |
| 独立插件 | 26 项业务/迁移测试及 3 项发布门槛测试通过，独立类型检查通过 |
| Windows 原生 | Go 逻辑测试、交叉编译和无桌面访问 self-test 通过；MSVC 生产录制器构建通过 |
| Windows 宿主 Node | 实际 Memmy.exe 的 Electron Node 模式、PATH 无系统 Node，通过下载/MCP/受控事件/生成/卸载保留数据；此项不包含新安装包 UI、真实桌面和真实模型 |
| 固定制品跨仓 | 在插件仓库仅消费 Host kit 与 ZIP；5 项受控链路通过。最终提交/哈希报告另随交付制品保存 |

既有失败不计作本次通过，也不以受控测试替代真实 Windows 验收。测试默认跳过的项目保留基线行为，正式跨仓输入缺失会直接失败。

## 发布尚需的外部条件

2026-10-20 用户确认：**本轮云端接入暂时留空**。本轮交付 Host 与插件源码、独立构建流程、本地 ZIP、来源/哈希及验收报告；不执行云端上传，不填写正式 catalog 或下载地址，不启用线上更新分发。保留既有读取接口与匿名回读工具，后续接入云服务时再配置实际发布入口、环境及可信来源。此项为明确暂缓范围，无须本轮补充云端凭据。

本地实现与验证不等同远端交付；本轮补齐的独立仓库、推送及 Host PR 见下节。Host 合入并正式发布后，再用无系统 Node 的 Windows 测试机完成真实模型四步对话、事件边界、试运行及独立输出核验。插件发布流程验证此证据并阻止提前发布。

云服务目前在本仓库只有 catalog/resolve/download 读取接口；后续实际写入发布入口和部署权限须由云服务提供，不能用本地开发 Registry 代替。插件仓库提供匿名云端回读及制品哈希检查脚本。交付清单中的云端字段本轮保留 null，并记录暂缓原因。

## 远端交付补齐

GitHub 登录已恢复，Teach Mode 源码与 `v0.3.0` 标签已推送到独立私有仓库 [Jovianix/teach-mode](https://github.com/Jovianix/teach-mode)。独立仓库的 [Linux / Windows CI](https://github.com/Jovianix/teach-mode/actions/runs/39404505540) 均通过。云端接入继续按本轮约定留空。

Host PR 目标为上游 `MemTensor/memmy-agent:survey_master`。该分支在指定基线后新增四个提交，当前为 `96aeb0ac7fd53f28273ab3184be74417225829ee`；fork 的 main 落后指定基线 356 个提交，不能作为本次 PR 的基线。为保留原验收记录，`codex/teach-mode-host-baseline` 仍停在 `508348b1`，另建 `codex/teach-mode-host-survey-master` 整合这四个上游提交。

解决 HomePage 唯一冲突时保留上游始终可用的 Host 录音按钮，另由插件贡献 Teach Mode 对话快捷入口；点击插件入口只准备对话指令。保留上游录制归档、滚轮隔离、样式与翻译修改。整合后渲染器类型检查、生产构建及 175 项相关测试通过，3 项维持跳过。HomePage 全套为 82 通过、11 失败；以当前上游原始 HomePage 重跑，失败项目逐项相同，没有新增失败。

此前固定制品及受控验收仍对应原 `508348b1` Host 候选，PR 分支新增的界面整合验证单独记录。Host 正式版本、真实 Windows 桌面和模型验收完成前，不将开发候选作为正式插件发布。远端 PR、来源提交与下载链接记录在交付清单中。

[Host 草稿 PR #684](https://github.com/MemTensor/memmy-agent/pull/684) 已创建并确认可合并。上游 Actions 返回 `action_required`，需要维护者处理；fork 已执行相同的 Host 兼容流程。首次运行 Linux 全部通过；Windows 检查暴露生成技能发现混用 JavaScript 与 native realpath、无法正确识别 8.3 短路径的问题，现已统一为与 Backend 异步 realpath 一致的原生规范路径。实际 Windows 宿主 Node 的短路径检查通过，包含技能发现、篡改撤下和停用。其余协议测试夹具明确使用所模拟的沙箱平台、平台路径与 file URL，不改变 Windows 默认沙箱或账号准入规则。修复后本地相关 Backend 55 通过、1 跳过，Agent 技能发现 3 项通过；远端复核结果继续记录在交付清单。

从独立插件 Windows CI 和 Host Linux CI 下载的固定版本、提交及 SHA-256 制品已完成 5 项跨仓受控检查，不读取对方仓库源码。CI 制品是开发候选；正式发布与真实 Windows 模型验收仍保持原门槛，云端字段继续留空。

共享采集的拒绝授权测试直接模拟 Host 预检拒绝结果，覆盖所有运行平台；不依赖仅适用于 macOS 的 TCC 权限读取。Windows 插件服务测试已通过，采集测试使用该平台无关夹具继续验证拒绝后没有进程或租约泄漏。

Windows 全部测试及 MSVC 原生构建已通过。Host kit 构建脚本将生成模块的绝对路径转换成 file URL 后再导入，修复 Windows 盘符路径被 ESM 当成协议的问题；实际 Windows 宿主 Node 已验证原盘符导入失败、file URL 导入成功，未访问桌面。

Windows 下载制品的来源复核还发现版本同步将八个已检出的 CRLF 文件写为 LF，导致 Git 报告工作区变更。已在实际 Windows 临时仓库中复现：同步前状态干净，同步后这八个文件被标记修改，内容 diff 为空。仅对这些生成文件固定 `eol=lf` 后，重新独立检出及同步均保持干净。CI 增加来源检查，Host kit 构建也拒绝带工作区变更的 CI 输入；不忽略实际源码变更或重置工作区。最终 CI 提交及制品哈希继续记录在交付清单。

## 2026-10-21：仅交付个人 fork 的 pxlin/dev

按用户要求，已关闭上游 PR #684；后续本轮修改只推送 `Jovianix/memmy-agent:pxlin/dev`，不重开 PR、不向上游推送，也不强制覆盖 fork 历史。整合基于本地已提交的 `275ed0c6`（包含远端 `92816b38`），合并已验证的 Host `febae477`，原工作区的未提交修改保留原样。

fork 已把 History 业务迁入共享 `core` 层，Windows 通过独立平台驱动运行；本次将插件事件订阅、用户后台采集意图、片段边界与 checkpoint 合并接入该共享层，保留 fork 的 Word / VS Code 适配、任务录制、静止画面与空闲写入策略。采集器的租约继续由平台驱动管理，避免 Host 再次申请同一门禁。宿主 Electron 的 Node 模式同样用于两个平台的采集入口。

Windows C++ 采集器沿用其已有协议，没有原生 checkpoint 水位。桥接仅确认已落盘数据，并明确回复 `complete: false`；不能用 fsync 代替原生队列已排空的证明，也不能把该协议限制当成历史丢失标记污染。对应教学片段仍可能为 `partial`，界面及验收报告保留这个状态。已有 Go 采集器的时间范围缺口检查仍保留，后续若为 C++ 增加原生 barrier，需要独立验证后才可提升完整性结论。

合并后的 Backend、Agent、Renderer 与 Electron 主进程类型编译通过。专项回归覆盖 208 项 Agent/采集测试（8 跳过）、44 项 Backend 测试、64 项 Desktop 测试，以及新增 Windows 平台驱动共享订阅检查。首页全套的 11 项失败在原 `febae477` 上逐项复现，另存对照证据；不把它们计为通过。真实 Windows 新对话和截图 PDF 使用本次合并构建，具体实际结果另附验收报告。云端接入继续按用户此前要求留空，本地开发 Registry 不作为线上分发验收。

### 本轮真实 Windows 复验结果

本次运行代码为 fork 合并提交 `51f797c91f1576e6f20bbf7511256bc512909b40`。对应 [Linux / Windows Host CI](https://github.com/Jovianix/memmy-agent/actions/runs/39556387192) 全部通过。通过隔离的 Windows Electron 开发实例、真实 `gpt-5.4` 对话与固定 Teach Mode `v0.3.0` ZIP 完成手动安装、权限确认、`/teach` 待命、明确开始、浏览器第 1 条示范、记事本保存、结束、单独生成技能和下一轮 GUI 执行。

- 新对话：`38e551bf-1395-4812-8717-4363e75e78e8`。录制：`3d682778-25ce-4327-9644-a40644ce70e2`，UTC `06:42:41.407` 至 `06:46:37.746`，9 条事件，`ready / partial`。计时条由 `00:00` 递增至 `00:05`，结束显示约 `03:56`。
- 事件 SHA-256：`03256c3113dcc5688274933e15f10c484c34f3f99d51626c415c36dc04f88d75`。生成技能与后续执行完成后重新核对，哈希未变，冻结事件没有超过停止截止时间。
- 新技能 `record-publications-fork-retest` 由真实 Skill Creator 保存并注册到 `teach-mode`；首次参数命名校验失败后，模型自行修正并保存成功。下一轮读取了新技能，生成与执行分开，未在执行时重新生成。
- 第 2–5 条实际通过记事本 `SetValue → Ctrl+S` 保存，未以 `write_file` 或 shell 代写。首次已匹配作者、标题、年份、论文链接共 16 个字段；“来源链接”被理解为出版社页面，随后在对话中澄清为与示范一致的 Publications 列表页，再由 Memmy 通过同一 GUI 流程修正。最终 20 个字段全部与独立浏览器的官方页面 DOM 一致。目标空文件由测试控制器预先创建，论文内容均由 Memmy 写入。
- 最终文件 SHA-256：`9ac3216d07bd5325340615571d6804ea44f28c2f474293365b17cb69c8ed8453`。仅观察编辑器开头和结尾截图，前后文件哈希一致。

首次录制失败时，另一个已安装的正式版 Memmy 原生采集器正在占用同一 Windows 会话的互斥。通过该实例自己的接口临时暂停后，开发实例录制成功；结束录制后已恢复正式版为 `running`，清理开发实例后再次确认仍在运行。正式版暂停响应曾附带既有 raw evidence incomplete/invalid 告警，恢复后 error 为 null；未修改或删除其历史数据。

浏览器执行曾等待独立于网页 DOM 的原生网站授权窗口；对 Bing 和交大官网均通过真实 UI 选择“允许本次会话”，没有写入长期网站授权。直接网页抓取因地址校验被拒绝后，模型改用内置浏览器读取公开页面。示范中的坐标点击曾被遮挡检查拒绝，使用明确定位的编辑器 UIA SetValue 后保存成功。

本轮不能作为完整录制或正式发布验收：fork 既有 Windows C++ 策略排除浏览器，技能的浏览器步骤来自演示者明确补充；C++ 仍缺少原生到磁盘水位，因此保留 `partial`，不能把健康时钟或 fsync 当成完整性证明。后续需补齐 C++ 原生 barrier 与浏览器隐私授权后的采集覆盖。当前 Windows 有系统 Node，控制脚本使用它，Agent / 插件使用宿主运行时；不宣称干净机无系统 Node 验收通过。开发运行还观察到 Session DAG 的 better-sqlite3 ABI 不匹配、Memory 超时及退出 drain listener 告警，未阻止本次实际链路，但不计作这些旁路能力通过。

测试实例退出码为 0，未触发强制退出超时；相关端口与本轮原生进程清理后均为空。保留用户原有记事本进程、原始标签及本轮输出供查看。操作步骤、原始截图、初次执行与修正后的文件、对话/工具轨迹、技能来源与独立核验 JSON 随本次对话的 PDF 和证据包交付。云端接入继续留空；本轮不创建或重开上游 PR。


## 2026-10-21：C++ 原生确认链路补齐

后续已实现带序号的原生 FIFO 标记、顺序处理、脱敏文件写入与 fsync 确认，Host 使用精确字节水位读取；缺口诊断一并落盘并按片段区间判定。新增标记不计为教学操作或活动摘要。还修复了周期读取在原生时间略领先时跳过事件并推进游标的竞态，最终停止继续遵循固定截止时间。

真实 Windows Host 复验得到 `available → partial → available`，保留旧片段缺口，恢复片段独立完整；11 个标记和 2 条缺口记录已保存，停止后的快照哈希不变。相关回归 762 项通过、21 项受平台限制跳过；原生 CTest 四项和交互桌面集成十一项通过。历史完整对话中的 partial 记录不自动改写；浏览器采集范围及云端接入边界保持此前记录。

实现、实机证据及基线已有检查问题见 [原生 checkpoint 专项报告](teach-mode-native-checkpoint-2026-10-21.md) 和 [验证摘要](verification/teach-mode-native-checkpoint-2026-10-21.json)。

缺口区间额外保留排队及合并通知的最早采集时间，防止停止前的丢失因延迟出队而被排除；原生阻塞输入回归已通过。
