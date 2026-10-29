const status = document.getElementById("status");
const refresh = document.getElementById("refresh");

async function showStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: "status" });
    if (!response?.connected) { status.textContent = "尚未连接到 Memmy。请先打开 Memmy。"; return; }
    const paused = response.pausedTabCount || 0;
    refresh.textContent = paused ? "重新连接" : "重新检查";
    if (paused) {
      status.textContent = `你关闭了浏览器顶部的调试提示，Memmy 已停止操作 ${paused} 个网页。点击“重新连接”即可恢复。`;
      return;
    }
    const count = response.controllableTabCount || 0;
    if (count) {
      status.textContent = `已连接到 Memmy，${count} 个网页可以操作。Memmy 执行任务时浏览器顶部会显示调试提示，任务结束后自动消失。`;
      return;
    }
    const issue = response.tabStatuses?.find(tab => tab.status === "protected") || response.tabStatuses?.[0];
    status.textContent = `已连接到 Memmy，当前没有可操作网页。${issue?.reason || "请打开普通网页后重新检查。"}`;
  } catch { status.textContent = "尚未连接到 Memmy。请先打开 Memmy。"; }
}

refresh.addEventListener("click", async () => {
  refresh.disabled = true; status.textContent = "正在检查浏览器页面…";
  try {
    const response = await chrome.runtime.sendMessage({ action: "refresh" });
    if (response?.ok) await showStatus();
    else status.textContent = response?.error || "无法重新连接，请确认 Memmy 已打开。";
  } catch { status.textContent = "无法重新连接，请确认 Memmy 已打开。"; }
  finally { refresh.disabled = false; }
});
void showStatus();
