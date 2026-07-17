export function memoryPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memmy Memory Panel</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --soft: #f2f5f4;
      --ink: #17201c;
      --muted: #66746f;
      --line: #d9dfdc;
      --accent: #0f766e;
      --accent-soft: #e6f3f1;
      --danger: #b33d3d;
      --code-bg: #111816;
      --code-fg: #e7eeee;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-size: 13px; letter-spacing: 0; }
    button, input, select { font: inherit; }
    button, input, select {
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
    }
    button { padding: 0 10px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    button:disabled { cursor: not-allowed; opacity: .45; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; }
    button.danger { color: var(--danger); }
    input, select { padding: 0 9px; outline: none; }
    select {
      appearance: none;
      -webkit-appearance: none;
      padding-right: 32px;
      background-color: var(--surface);
      background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3e%3cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2366746f' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3e%3c/svg%3e");
      background-repeat: no-repeat;
      background-position: right 12px center;
      background-size: 12px 12px;
    }
    select {
      appearance: none;
      -webkit-appearance: none;
      padding-right: 32px;
      background-color: var(--surface);
      background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3e%3cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2366746f' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3e%3c/svg%3e");
      background-repeat: no-repeat;
      background-position: right 12px center;
      background-size: 12px 12px;
    }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
    header {
      min-height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 16px; line-height: 1.2; }
    h2 { margin: 0; font-size: 13px; line-height: 1.2; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 8px 9px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; background: var(--soft); color: var(--muted); font-size: 11px; font-weight: 700; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: #f3f7f6; }
    tbody tr.selected { background: var(--accent-soft); }
    pre {
      margin: 0;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--code-bg);
      color: var(--code-fg);
      border-radius: 6px;
      padding: 10px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .muted { color: var(--muted); }
    .ok { color: var(--accent); }
    .error { color: var(--danger); }
    .shell { padding: 12px 14px 16px; display: grid; gap: 10px; }
    .header-actions { display: flex; align-items: center; gap: 8px; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 8px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface);
      padding: 9px 10px;
    }
    .stat span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
    .stat strong { display: block; font-size: 20px; line-height: 1.1; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) 112px 132px auto auto;
      gap: 8px;
      align-items: center;
    }
    .workspace {
      display: grid;
      grid-template-columns: minmax(520px, 1fr) minmax(600px, 760px);
      gap: 10px;
      height: calc(100vh - 176px);
      min-height: 360px;
      align-items: stretch;
    }
    .panel {
      min-width: 0;
      height: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .panel-head {
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--soft);
    }
    .table-wrap { flex: 1; min-height: 0; overflow: auto; }
    .detail-body { flex: 1; min-height: 0; padding: 10px; }
    .detail-body pre { height: 100%; min-height: 0; }
    .footer {
      min-height: 34px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 7px 10px;
      border-top: 1px solid var(--line);
      background: var(--soft);
      color: var(--muted);
    }
    .pager { display: flex; align-items: center; gap: 7px; }
    .pager input {
      width: 48px;
      min-height: 28px;
      text-align: center;
      padding: 0 6px;
    }
    .pager button {
      min-width: 28px;
      min-height: 28px;
      padding: 0;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 0 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--soft);
      color: var(--muted);
      font-size: 11px;
      line-height: 18px;
      vertical-align: middle;
    }
    .layer-L1 { color: #315c9a; border-color: #b8c7df; background: #eef4fb; }
    .layer-L2 { color: var(--accent); border-color: #b7d6cf; background: #edf8f5; }
    .layer-L3 { color: #9a6a14; border-color: #e4d2a7; background: #fbf6e7; }
    .layer-Skill { color: #7b3f7f; border-color: #d9bdd8; background: #fbf0fb; }
    .status-deleted, .status-archived { color: var(--danger); }
    .memory-title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .memory-summary { margin-top: 3px; color: #3f4d48; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .memory-id { margin-top: 3px; color: var(--muted); font-size: 11px; white-space: normal; overflow-wrap: anywhere; }
    .empty { padding: 18px; color: var(--muted); text-align: center; }
    .hidden { display: none; }
    @media (max-width: 1180px) {
      .workspace { grid-template-columns: 1fr; }
      .workspace { height: auto; }
      .table-wrap { max-height: 360px; }
      .detail-body pre { height: 300px; }
    }
    @media (max-width: 720px) {
      header { align-items: stretch; flex-direction: column; }
      .toolbar { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Memmy Memory Panel</h1>
    <div class="header-actions">
      <button id="refresh" class="primary">Refresh</button>
    </div>
  </header>
  <main class="shell">
    <div id="errorMessage" class="error hidden"></div>
    <section class="stats" id="stats" aria-label="Layer counts"></section>
    <section class="toolbar" aria-label="Memory filters">
      <input id="query" placeholder="Search memory">
      <select id="layer" aria-label="Layer">
        <option value="">All layers</option>
        <option value="L1">L1</option>
        <option value="L2">L2</option>
        <option value="L3">L3</option>
        <option value="Skill">Skill</option>
      </select>
      <select id="status" aria-label="Status">
        <option value="">All statuses</option>
        <option value="activated">activated</option>
        <option value="resolving">resolving</option>
        <option value="archived">archived</option>
        <option value="deleted">deleted</option>
      </select>
      <button id="search">Search</button>
      <button id="clearFilters">Clear</button>
    </section>
    <section class="workspace">
      <div class="panel">
        <div class="panel-head">
          <h2>Memories</h2>
          <span id="listMeta" class="muted">Idle</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:82px">Layer</th>
                <th>Memory</th>
                <th style="width:116px">Status</th>
                <th style="width:148px">Updated</th>
              </tr>
            </thead>
            <tbody id="memoryRows"></tbody>
          </table>
          <div id="emptyState" class="empty hidden">No memory rows</div>
        </div>
        <div class="footer">
          <div class="pager">
            <button id="prevPage" aria-label="Previous page">&lt;</button>
            <input id="pageInput" class="mono" inputmode="numeric" aria-label="Page number" value="1">
            <span class="mono">/</span>
            <span id="totalPagesText" class="mono">1</span>
            <button id="nextPage" aria-label="Next page">&gt;</button>
          </div>
        </div>
      </div>
      <aside class="panel">
        <div class="panel-head">
          <div>
            <h2 id="detailTitle">Select a memory</h2>
            <div id="detailId" class="memory-id mono"></div>
          </div>
          <button id="copyJson">Copy JSON</button>
        </div>
        <div class="detail-body">
          <pre id="detailJson">{}</pre>
        </div>
      </aside>
    </section>
  </main>
  <script>
    const state = {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 1,
      selectedMemoryId: undefined,
      detailJson: {},
      lastRequestMs: 0
    };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

    async function api(path, options = {}) {
      const started = Date.now();
      const response = await fetch(path, options);
      state.lastRequestMs = Date.now() - started;
      const text = await response.text();
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
      if (!response.ok) {
        const message = body.error && body.error.message ? body.error.message : text || response.statusText;
        throw new Error(message);
      }
      return body;
    }

    function clearError() {
      $("errorMessage").classList.add("hidden");
      $("errorMessage").textContent = "";
    }

    function showError(error) {
      $("errorMessage").classList.remove("hidden");
      $("errorMessage").textContent = error.message || String(error);
    }

    function formatNumber(value) {
      const number = Number(value || 0);
      return Number.isFinite(number) ? number.toLocaleString() : "0";
    }

    function formatDate(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    function displayMemoryTitle(title, fallback) {
      const cleaned = String(title || "").replace(/^\\s*Summary:\\s*/i, "").trim();
      return cleaned || fallback;
    }

    function paramsForList() {
      const params = new URLSearchParams();
      params.set("page", String(state.page));
      const q = $("query").value.trim();
      if (q) params.set("q", q);
      if ($("layer").value) params.set("layer", $("layer").value);
      if ($("status").value) params.set("status", $("status").value);
      return params;
    }

    function renderStats(overview) {
      const counts = overview.counts || {};
      $("stats").innerHTML = [
        ["L1", counts.memories],
        ["L2", counts.experiences],
        ["L3", counts.worldModels],
        ["Skill", counts.skills]
      ].map(([label, value]) => '<div class="stat"><span>' + esc(label) + '</span><strong>' + esc(formatNumber(value)) + '</strong></div>').join("");
    }

    function renderRows(items) {
      $("emptyState").classList.toggle("hidden", items.length > 0);
      $("memoryRows").innerHTML = items.map((item) =>
        '<tr data-id="' + esc(item.id) + '" class="' + (item.id === state.selectedMemoryId ? "selected" : "") + '">' +
          '<td><span class="pill layer-' + esc(item.memoryLayer) + '">' + esc(item.memoryLayer) + '</span></td>' +
          '<td><div class="memory-title">' + esc(displayMemoryTitle(item.title, item.id)) + '</div><div class="memory-summary">' + esc(item.summary || "") +
          '</div><div class="memory-id mono">' + esc(item.id) + '</div></td>' +
          '<td><span class="status-' + esc(item.status) + '">' + esc(item.status) + '</span></td>' +
          '<td>' + esc(formatDate(item.updatedAt || item.createdAt)) + '<div class="muted mono">v' + esc(item.version || 1) + '</div></td>' +
        '</tr>'
      ).join("");
      for (const row of $("memoryRows").querySelectorAll("tr")) {
        row.onclick = () => loadMemoryDetail(row.dataset.id);
      }
    }

    function renderListMeta(data) {
      const shown = Array.isArray(data.items) ? data.items.length : 0;
      $("listMeta").textContent = formatNumber(shown) + " shown / " + formatNumber(data.total) + " matched / " + state.lastRequestMs + " ms";
      $("pageInput").value = String(state.page);
      $("totalPagesText").textContent = String(state.totalPages);
      $("prevPage").disabled = !data.hasPrev;
      $("nextPage").disabled = !data.hasNext;
    }

    async function loadOverview() {
      const overview = await api("/api/v1/panel/overview");
      renderStats(overview);
    }

    async function loadMemories() {
      const data = await api("/api/v1/panel/items?" + paramsForList().toString());
      state.page = data.page || state.page;
      state.pageSize = data.pageSize || state.pageSize;
      state.total = data.total || 0;
      state.totalPages = data.totalPages || 1;
      renderRows(data.items || []);
      renderListMeta(data);
      if (!state.selectedMemoryId) {
        state.detailJson = data;
        $("detailTitle").textContent = "List response";
        $("detailId").textContent = "/api/v1/panel/items";
        $("detailJson").textContent = JSON.stringify(data, null, 2);
      }
    }

    async function loadMemoryDetail(id) {
      if (!id) return;
      const requestedMemoryId = id;
      state.selectedMemoryId = requestedMemoryId;
      clearError();
      for (const row of $("memoryRows").querySelectorAll("tr")) {
        row.classList.toggle("selected", row.dataset.id === requestedMemoryId);
      }
      const loadingJson = { loading: true, id: requestedMemoryId };
      state.detailJson = loadingJson;
      $("detailTitle").textContent = "Loading memory";
      $("detailId").textContent = requestedMemoryId;
      $("detailJson").textContent = JSON.stringify(loadingJson, null, 2);
      try {
        const data = await api("/api/v1/memory/" + encodeURIComponent(requestedMemoryId));
        if (state.selectedMemoryId !== requestedMemoryId) return;
        state.detailJson = data;
        const item = data.item || {};
        $("detailTitle").textContent = displayMemoryTitle(item.title, requestedMemoryId);
        $("detailId").textContent = requestedMemoryId;
        $("detailJson").textContent = JSON.stringify(data, null, 2);
      } catch (error) {
        if (state.selectedMemoryId !== requestedMemoryId) return;
        const message = error.message || String(error);
        const errorJson = { error: message, id: requestedMemoryId };
        state.detailJson = errorJson;
        $("detailTitle").textContent = "Memory detail failed";
        $("detailId").textContent = requestedMemoryId;
        $("detailJson").textContent = JSON.stringify(errorJson, null, 2);
        showError(error);
      }
    }

    async function refreshAll() {
      try {
        clearError();
        await Promise.all([loadOverview(), loadMemories()]);
      } catch (error) {
        showError(error);
      }
    }

    async function applyFilters() {
      state.page = 1;
      state.selectedMemoryId = undefined;
      await refreshAll();
    }

    async function copyDetailJson() {
      await navigator.clipboard.writeText(JSON.stringify(state.detailJson || {}, null, 2));
    }

    async function goToPage() {
      const nextPage = Number($("pageInput").value);
      if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > state.totalPages) {
        $("pageInput").value = String(state.page);
        return;
      }
      state.page = nextPage;
      state.selectedMemoryId = undefined;
      await loadMemories();
    }

    $("refresh").onclick = refreshAll;
    $("search").onclick = applyFilters;
    $("clearFilters").onclick = () => {
      $("query").value = "";
      $("layer").value = "";
      $("status").value = "";
      applyFilters();
    };
    $("prevPage").onclick = () => {
      if (state.page <= 1) return;
      state.page -= 1;
      loadMemories();
    };
    $("nextPage").onclick = () => {
      if (state.page >= state.totalPages) return;
      state.page += 1;
      loadMemories();
    };
    $("pageInput").onkeydown = (event) => {
      if (event.key === "Enter") goToPage();
    };
    $("pageInput").onfocus = () => $("pageInput").select();
    $("pageInput").onclick = () => setTimeout(() => $("pageInput").select(), 0);
    $("pageInput").onchange = goToPage;
    $("query").onkeydown = (event) => {
      if (event.key === "Enter") applyFilters();
    };
    $("layer").onchange = applyFilters;
    $("status").onchange = applyFilters;
    $("copyJson").onclick = copyDetailJson;
    refreshAll();
  </script>
</body>
</html>`;
}
