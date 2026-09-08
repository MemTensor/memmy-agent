#!/usr/bin/env bash
# Replay a workflow memory document through Cua Driver's MCP tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MEMMY_JS="$ROOT_DIR/App/memmy-agent/dist/main.js"

WORKFLOW_FILE="${1:?usage: replay-cua.sh <workflow-file> [var=value ...]}"
shift || true

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  echo "[replay-cua] missing workflow: $WORKFLOW_FILE" >&2
  exit 1
fi
if [[ ! -f "$MEMMY_JS" ]]; then
  echo "[replay-cua] Memmy Agent is not built." >&2
  echo "[replay-cua] run: npm --prefix App/memmy-agent run build" >&2
  exit 1
fi
if ! command -v cua-driver >/dev/null 2>&1; then
  echo "[replay-cua] cua-driver is not installed or not in PATH." >&2
  exit 1
fi

WORKFLOW_ABS="$(cd "$(dirname "$WORKFLOW_FILE")" && pwd)/$(basename "$WORKFLOW_FILE")"

VARS=""
for pair in "$@"; do
  VARS="$VARS
- $pair"
done
if [[ -z "$VARS" ]]; then
  VARS="
（未提供；如文档 variables 非空，使用其中的 example 值并在开始前说明）"
fi

PROMPT="你是流程回放执行器。读取流程文档：$WORKFLOW_ABS
按文档中的语义步骤，通过 mcp_cua_* 工具在真实桌面上回放流程。执行规则：
- 本次变量取值：$VARS
- 除读取流程文档外，只能使用 mcp_cua_* 工具；不得使用 computer_*、browser、exec、osascript 或其他桌面控制方式；
- 先用 mcp_cua_list_apps 定位目标应用。应用已运行时不要创建新的 application instance；
- 调用 mcp_cua_list_windows 时优先使用 on_screen_only=true，并选择有正常标题、面积最大的主内容窗口。忽略高度小于 300 或宽度小于 500 的菜单栏、工具条、图标和辅助窗口；
- 每一步操作前调用 mcp_cua_get_window_state。已知目标文字时优先使用 query，并将 max_elements 控制在 80、max_depth 控制在 8；一次只调用一个带截图的状态工具，避免并行获取多张截图；
- 优先使用最新状态中的 element_token 操作。只有元素树无法定位时，才使用同一次截图中的像素坐标；获取新状态后不得复用旧 element_token；
- 若主窗口返回 elements=0、ax_unresolved 或 ax_window_unresolved，不要遍历同一应用的多个小窗口。若同一次 window-scoped 截图仍清晰显示目标状态，可以用该视觉证据继续；否则再激活已有主应用，改用 mcp_cua_get_desktop_state 获取主屏状态；
- Workflow 给出目标 URL 时，优先调用 mcp_cua_launch_app，传入 bundle_id=com.google.Chrome、creates_new_application_instance=false、urls=[目标 URL]。Chrome 已运行时这可以打开新标签页，但不能启动第二个 Chrome 进程；调用后重新列出 Chrome 窗口并验证目标页面；
- 如果 launch_app 没有完成导航，只允许一次键盘回退：先对 Chrome 主窗口发送 delivery_mode=foreground 的 cmd+l，让 Chrome 成为前台应用；随后使用 scope=desktop、delivery_mode=foreground（不要同时传 target、pid 或 window_id）完整执行 cmd+l、输入目标 URL、return；
- 不要使用 background type_text 或 AX set-value 只把 URL 填进地址栏后，再发送 window-scoped return。地址栏显示 URL 只证明文本写入，不证明地址栏有键盘焦点或导航已提交；
- 重新获取 Chrome 主窗口或桌面状态，只有标题、页面正文或截图出现目标页面证据才算导航成功；不要把“打开 Chrome”或“地址栏已有 URL”当成完成；
- 每个关键动作后重新列出目标应用窗口，使用标题正常且面积最大的主内容窗口做定向验证。目标窗口被 Memmy/Electron 或其他窗口遮挡不等于动作失败；主屏截图显示 Electron 也不能单独作为失败证据；
- 最终验证优先使用目标应用的 window-scoped 截图、窗口标题和可访问性内容。只有定向窗口证据不可用时，才把目标应用重新置前并使用桌面截图；
- 点击、输入、按键和滚动后都重新获取界面状态，用截图和可访问性内容共同验证。工具调用成功不等于任务完成；
- 如果 Workflow 定义 Gate/检查表，必须严格按编号推进，并在日志中持续报告 verified/pending 状态。当前 Gate 没有新 UI 证据时，不得寻找、点击或处理后续 Gate；
- 录制中的滚动距离不是回放参数。每次最多滚动一个视口，立即重新获取状态；下一语义目标已经可见时不得继续滚动，禁止一次 page scroll 的 amount 大于 1；
- 在 Add to Bag、保存、发送、提交、删除、结账或支付等后果性动作前，必须证明所有前置 Gate 已完成，并在执行前输出最终核对摘要；
- 后台操作没有生效时，先重新定位；仍失败再对该动作使用 delivery_mode=foreground；
- 输入文字前确保目标输入框实际获得焦点，输入后必须在新状态中确认预期文字；
- 验证失败先执行文档中的回退；连续两次无法推进就停止并报告；
- 「敏感：是」的步骤不要执行，停下来说明需要人工完成；
- 完成后对照成功判据逐项报告，并说明与原始流程的偏差；
- 只有所有成功判据均已通过验证时，最终回复的最后一行必须是纯文本 CUA_RUN_RESULT: success；任何步骤未完成、验证失败、权限不足或模型错误时，最后一行必须是纯文本 CUA_RUN_RESULT: failed。不要用反斜杠转义下划线。"

echo "[replay-cua] workflow: $WORKFLOW_ABS"
echo "[replay-cua] backend: Cua Driver MCP"
RUN_LOG="$(mktemp -t memmy-cua-run.XXXXXX)"
trap 'rm -f "$RUN_LOG"' EXIT

set +e
MEMMY_COMPUTER_USE=0 MEMMY_COMPUTER_HISTORY=0 node "$MEMMY_JS" agent --standalone -w "$ROOT_DIR" --no-markdown -m "$PROMPT" | tee "$RUN_LOG"
AGENT_STATUS=${PIPESTATUS[0]}
set -e

if [[ "$AGENT_STATUS" -ne 0 ]]; then
  echo "[replay-cua] failed: agent process exited with code $AGENT_STATUS" >&2
  exit "$AGENT_STATUS"
fi
if grep -Eq '^CUA_RUN_RESULT: success[[:space:]]*$' "$RUN_LOG"; then
  echo "[replay-cua] verified success"
  exit 0
fi

echo "[replay-cua] failed: agent did not report verified workflow success" >&2
exit 2
