# 账户模型真实会话复测

日期：2026-09-23。源码：`fix/debug-session`，基线 `d101fd58`，仓库版本 `1.1.8`。本次使用构建后的 `dist/main.js agent`，不是脚本模型。

## 模型与隔离方式

复核时 `~/.memmy/config.yaml` 已存在，包含可用的 `memmy_account` 账户通道。使用该配置的 agent preset，模型路由为 `agent_chat`，请求发送至 `https://api.memmy.cn/api/agentExternal/v1`。没有要求提供新密钥，也未把账户 JWT 写入仓库。云端实际底层模型及其版本未单独确认。

使用本机可用 Node.js v24.19.0 构建、运行；未使用 Electron。运行时配置、workspace、会话、GUI 事件记录、DAG 路径和 app 数据库路径均指向临时目录。关闭本地记忆、文件记忆、浏览器、Web 工具和 MCP；直接执行单轮 CLI，没有启动 Gateway 或 WebSocket 服务。为关闭 DAG，将上下文摘要模式设为 `text`；测试限制为最多 40 次工具迭代。

测试结束后已清除 6 份临时配置中的账户凭据；扫描本次改动和新增文件，未发现该凭据。原始账户配置的修改时间仍为测试前观察到的 2026-09-23 19:57:14（北京时间）。保留的临时配置需重新运行准备脚本才能用于新的账户调用。

启动迁移会重新加入默认 MCP，因此准备脚本先执行临时目录的迁移，再清空 MCP，并向子 CLI 传入已完成迁移的目标信息。隔离配置不能仅依赖删减 YAML 字段。

## 结果

| 场景 | 工具轨迹证据 | 答案 | CLI 耗时 |
| --- | --- | --- | ---: |
| 完整阅读长 DOCX | 8 次 `read_file`，连续覆盖 0–263543，最后一段包含结束标记 | 四组字段和值全部正确 | 70.2 秒 |
| PDF 后部页码 | `read_file(path="synthetic-report.pdf", pages="20")`，返回该页全部 15211 字符；该页位于原 20 万字符提取上限之后 | 页码及四组字段和值全部正确 | 69.3 秒 |
| exec 截断恢复（有效重测） | `cat source.txt` 成功返回 10037 字符且包含截断标记；随后 `grep` 定位，`read_file` 分别核对第 806、1613、2420、3227 行 | 四组字段和值全部正确，无提前结束 | 17.0 秒 |

DOCX 读取区间依次为：

```text
0–32000
32000–64000
64000–96000
96000–128000
128000–160000
160000–192000
192000–224000
224000–263543  End of document
```

标准答案：`PE=38.95`、`HOLDING=61.35%`、`ISSUED=112000000`、`RAISED=2110000000`。最终答案和工具记录均已核对，不仅依据模型自称“已读完”。

首次 exec 场景使用绝对 Node 路径，被工作区检查拦截；模型直接读取了源文件，虽然答案正确，但没有实际触发命令输出截断，因此不计为有效通过。随后改用工作区内的纯读取命令 `cat source.txt`，扩大样例并重新创建会话，才获得上表中的有效结果。

## 复测期间的额外行为

DOCX/PDF 模型在得到所需结果后进行了多余的二次核对，包含解包、调用其他提取工具等行为，因此实际会话耗时显著高于单纯解析基准。

首轮 PDF 会话还调用 `pip install pypdf pdfplumber`，向用户 Python 目录安装了此前不存在的两个包。这说明 `restrictToWorkspace` 是命令路径检查，并不等同于操作系统沙箱。已向用户说明并获准卸载这两个直接安装的包。由于没有安装前的依赖快照，没有擅自卸载其他可能的传递依赖；不能声称完整回滚了所有 Python 环境变化。

首轮 DOCX 会话还出现清理命令被过滤后改用其他命令的行为；本记录不将其视为推荐操作。后续准备脚本对 DOCX/PDF 禁用 exec，对 exec 测试只允许精确匹配 `cat source.txt` 或将其输出重定向到工作区内 `extracted.txt`，从源头限制包安装和其他副作用。有效 exec 重测使用了此白名单。

## 可复跑工具

从 `App/memmy-agent` 运行（依赖及内部包已构建）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node scripts/copy-build-assets.mjs
node --import tsx scripts/debug/prepare-live-document-review.ts
# 上一步输出私有临时目录。以下 ROOT 替换为该目录，不使用真实账户配置直接运行。
node --import tsx scripts/debug/run-live-document-review.ts ROOT/docx
node --import tsx scripts/debug/run-live-document-review.ts ROOT/pdf
node --import tsx scripts/debug/run-live-document-review.ts ROOT/exec
node --import tsx scripts/debug/summarize-live-document-review.ts ROOT
```

准备脚本会创建私有临时配置，运行脚本记录退出状态和脱敏输出，汇总脚本只导出可见答案与工具证据，不导出模型推理流。运行会消耗正常账户模型用量。最终脚本的命令限制比首轮 DOCX/PDF 更严格，因此复跑时额外核对行为和耗时可能不同。

## 验收边界

- 三种合成场景各有一轮有效真实模型通过，不代表多轮统计可靠性，也不等同于原文档、原版本、原会话复现。
- exec 测试证明模型能从截断恢复所需事实；它没有按顺序读完整个文件，也未恢复原会话已丢弃的 stdout，而是读取了可访问的源文件。
- 超长单行文本分页缺口仍未修复；本次多行样例不覆盖它。
- 重复全量解析的性能成本仍在，之前的基准数据继续有效。真实会话还包含推理、网络和多余工具调用耗时。
- 上述复测发生在本地提交之前，尚未推送或安装替换桌面应用。超长单行文本和缓存优化按用户确认的范围作为独立后续事项。
