# 长文档读取截断修复记录

## 问题与基线

- 分支：`fix/debug-session`
- 基线：`d101fd582857ddc046416f5f08741297345992dc`
- 用户现象：Agent 报告原文或 PDF 页面在工具输出中被截断，未继续核实后文。
- 证据范围：已根据代码和测试复现文档读取链路缺陷；没有截图对应会话的工具调用日志、模型配置或原始文档，尚未复测该会话。

## 根因

1. `utils/document.ts` 各解析器只保留提取结果的前 200,000 个 UTF-16 单元。
2. `read_file` 又截取前 128,000 个单元，未提供文档续读游标。文本文件的 `offset`、`limit` 不作用于 PDF 或 Office 文档。
3. PDF 页码筛选发生在提取层截断之后，因此后部页码可能被误判为无效。
4. 截断提示附加在输出上限之后，可能再次被运行时结果预算处理。

命令工具另有输出上限；此次为该路径增加恢复读取指引，未修改命令输出保存机制。

## 修改后行为

- 提取器默认仍提供 200,000 单元的预览；分页读取显式请求完整提取结果。
- 文档工具先选择 PDF 页码，再按 `char_offset`、`char_limit` 返回内容；默认块大小为 32,000 单元。
- `char_offset` 从 0 开始，按 JavaScript UTF-16 字符串索引计算。调用者应使用工具返回的游标，不自行计算中文或 emoji 的长度。
- 返回当前范围、总长度，以及后续游标或结束标记。续读时保持 `path` 和 `pages` 不变。
- 即使请求极大块，也为续读提示预留输出预算；自动分段不会拆开有效的 UTF-16 代理对。
- Agent 指引要求继续读取任务所需范围；需要完整阅读时必须读到结束。若命令提取输出被截断，应保存到文件分段读取，或改用原始文档的 `read_file`。

调用示例：

```json
{"path":"report.pdf","pages":"15","char_limit":32000}
```

如结果提示 `Continue with char_offset=32000`，继续：

```json
{"path":"report.pdf","pages":"15","char_offset":32000,"char_limit":32000}
```

## 验证

环境：macOS、本地 Node.js v24.19.0、agent 锁文件中的 Vitest 4.1.7。

修复读取逻辑之前，6 个新用例失败，涵盖四种文档续读、PDF 页内续读、无效游标。修复后运行以下测试文件：

```bash
cd App/memmy-agent
MEMMY_AGENT_DATA_DIR=/private/tmp/memmy-debug-test-data node node_modules/vitest/vitest.mjs run \
  tests/document-parsing.test.ts \
  tests/core/agent-runtime/tools/read-enhancements.test.ts \
  tests/core/agent-runtime/tools/filesystem-tools.test.ts \
  tests/core/agent-runtime/tools/tool-descriptions.test.ts \
  tests/utils/prompt-templates.test.ts \
  tests/core/agent-runtime/tool-result-budget.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

测试前按两份锁文件安装依赖，并构建 Migrations、Knowledge、local-api-contracts 内部包。测试数据使用临时目录，避免写入日常 Memmy 数据目录。

结果：6 个测试文件、135 个测试通过，类型检查通过。覆盖真实长 DOCX 完整拼接、累计提取量超过 200,000 单元的 PDF 第 15 页、四种文档的无损分段、最大块预算、emoji 边界和错误输入。

## 边界与上线验证

- 仍依赖文档现有文本提取能力；扫描 PDF 的 OCR 不在此次修复范围。
- 每次续读会重新提取文档，超大文档可能较慢；读取过程中应保持文件不变。
- 提供续读能力和模型指引不能保证所有模型都会正确续读。需使用原模型及原文档进行会话级复测，确认核实了目标数据后再报告完成。
- 代码尚未打包或安装到桌面应用，已安装版本不会因本地源码修改自动更新。
