# 文档覆盖清单

核对基线：MemTensor/memmy-agent main，`8cd095c7f67300b6582a912bdd7fd33163d5e5b4`（package.json 1.2.3）。产品界面文案另与当前本地代码交叉核对。本表是维护记录，不作为网站正文；实现核对不等于完成真实模型效果验收。

| 能力 | 用户文档 | 主要核对来源 | 使用条件或边界 |
| --- | --- | --- | --- |
| 任务、附件、语音与模型选择 | cn/desktop/workbench.mdx | App/frontend/desktop/src/pages/home-page.tsx、i18n/messages.ts | 语音需要权限与可用识别模型 |
| 录音、上传音频与转写 | cn/desktop/recording.mdx | App/frontend/desktop/src/pages/recording-entry.tsx、i18n/messages.ts | 需要登录；转写失败时录音仍保留，可重试 |
| 项目与本地文件夹 | cn/desktop/projects.mdx | pages/app-frame.tsx 的 createProject、home-page.tsx | 本机可访问的文件夹；移除项目需看清任务删除范围 |
| 文件产物与预览 | cn/desktop/files.mdx | home-page.tsx 的 sessionArtifactClient / thread panel | 能生成文件不等于文件已验收；输出路径需明确 |
| 浏览器与网页 | cn/desktop/browser.mdx | pages/browser-agent-settings.tsx、browser-extension-setup.tsx | 外部浏览器需扩展和连接，网页访问受授权限制 |
| 电脑操控 | cn/desktop/computer-use.mdx | pages/computer-use-settings.tsx | 系统与应用权限、可交互桌面 |
| 提醒与定时任务 | 公开页已暂时撤下 | App/memmy-agent/src/core/agent-runtime/tools/cron.ts、cron/service.ts | 已实现 add/list/remove；本地运行依赖服务可用，不承诺关机后执行 |
| 桌宠 | cn/desktop/pet.mdx | App/frontend/desktop 桌宠界面和窗口设置 | 可选入口，继续复用任务 |
| 记忆检索与管理 | cn/memory/overview.mdx | pages/memory/*、Memory | 索引存在处理延迟，来源需核对 |
| Computer History | cn/memory/computer-history.mdx | computer-history-sub-page.tsx、permission guide、i18n | macOS/Windows 11；内容可能交由模型分析；删除关联记忆与 Skill |
| 跨 Agent 接入与续接 | cn/memory/sources.mdx | 原 sources.mdx 中的 Hook/Skill/resume 契约，Memory 集成 | 同机服务、来源同步、目标安装组件、文件访问分别检查 |
| 知识库 | cn/knowledge/overview.mdx | Knowledge/src/ui/page.tsx，pages/knowledge-page.tsx | 登录、处理成功、参与召回；接收共享方只读 |
| 技能与来源审阅 | cn/memory/learned-skills.mdx | pages/memory/skills-sub-page.tsx、i18n | History 待审阅技能不能当成已验证自动执行能力 |
| 外部工具和消息渠道 | cn/tools/integrations.mdx、cn/channels/index.mdx | tools 页、integrations 客户端、i18n | 以当前可连接项及权限范围为准 |
| 插件 | cn/plugins/overview.mdx、cn/plugins/office.mdx、cn/plugins/literature-review.mdx | plugin-marketplace-section.tsx、official-plugin-catalog.ts、plugins/office/plugin.json、i18n/messages.ts | 文档页称「插件」。产品入口仍是「连接与工具」顶部的「任务插件」。默认目录声明文献综述、Office、劳动法律 beta；页面以当前卡片为准。Office 不要求登录。文献综述要求登录，并建议自行配置较强模型。 |
| 模型、账号、隐私 | cn/models/*、cn/desktop/settings.mdx、cn/security/security.mdx | 设置、欢迎页、Knowledge UI 上传/共享 | 不写未确认的积分/套餐数值；本机记忆与云端处理区分 |
| 终端、MCP、API、源码 | cn/terminal/*、cn/reference/*、cn/development/* | 保留现有工程参考 | 归入开发者区；本轮未重新验证所有接口契约 |

跟着做现为两页：Office 侧栏名「适配 Office 工具」，文献综述侧栏名「文献综述」。文件任务、电脑历史续接、跨 Agent 续接仍分别写在 files、computer-history、sources。其余插件不按场景拆页。虚构的培训示例材料在 examples/training-notes.md。

网站由独立 Memmy-Web 项目渲染。更新日志由网站维护，必须经过 `prepare-local-docs.mjs` / 远端同步后的 overrides 步骤保留。中文新增页未翻译时，英文页面必须提示正在显示中文内容。
