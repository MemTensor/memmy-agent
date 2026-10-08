const status = document.getElementById("status");

chrome.runtime.sendMessage({ action: "status" }).then(response => {
  status.textContent = response?.connected
    ? "已连接到 Memmy，可以操作这个浏览器中的网页。"
    : "尚未连接到 Memmy。请先打开 Memmy。";
}).catch(() => {
  status.textContent = "尚未连接到 Memmy。请先打开 Memmy。";
});
