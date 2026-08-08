export function memoryPanelHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="data:,">
  <title>Memmy Memory Console</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #f4f6f7;
      --surface: #ffffff;
      --surface-raised: #ffffff;
      --surface-soft: #eef2f2;
      --surface-hover: #e8efed;
      --ink: #17211e;
      --ink-secondary: #42504c;
      --muted: #6d7975;
      --line: #d8dfdc;
      --line-strong: #bec9c5;
      --accent: #087f6b;
      --accent-hover: #056b5b;
      --accent-soft: #dff3ed;
      --blue: #326aa8;
      --blue-soft: #e7f0fa;
      --amber: #9a6711;
      --amber-soft: #f8efd9;
      --violet: #76518c;
      --violet-soft: #f0e8f4;
      --danger: #b33f49;
      --danger-soft: #fae9eb;
      --success: #087f6b;
      --code-bg: #111816;
      --code-fg: #e7eeee;
      --shadow: 0 8px 24px rgba(20, 35, 30, .08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :root.dark {
      color-scheme: dark;
      --canvas: #111614;
      --surface: #171e1b;
      --surface-raised: #1c2521;
      --surface-soft: #202a26;
      --surface-hover: #26332e;
      --ink: #edf4f1;
      --ink-secondary: #bdc9c4;
      --muted: #8f9c97;
      --line: #303c37;
      --line-strong: #46534e;
      --accent: #42bda5;
      --accent-hover: #67ccb8;
      --accent-soft: #183b33;
      --blue: #7eafe5;
      --blue-soft: #1c3045;
      --amber: #d8ad59;
      --amber-soft: #3a301d;
      --violet: #c09bd2;
      --violet-soft: #34263b;
      --danger: #ef8c94;
      --danger-soft: #44252a;
      --success: #42bda5;
      --code-bg: #0c110f;
      --code-fg: #dbe6e2;
      --shadow: 0 12px 30px rgba(0, 0, 0, .28);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; background: var(--canvas); color: var(--ink); font-size: 13px; letter-spacing: 0; }
    button, input, select { font: inherit; }
    button, input, select {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
    }
    button { padding: 0 11px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--line-strong); background: var(--surface-hover); }
    button:disabled { cursor: not-allowed; opacity: .45; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); color: #fff; }
    button.ghost { border-color: transparent; background: transparent; }
    button.danger { color: var(--danger); }
    button.danger:hover:not(:disabled) { background: var(--danger-soft); border-color: var(--danger); }
    button.icon-button { width: 34px; padding: 0; font-size: 17px; line-height: 1; }
    input, select { padding: 0 10px; outline: none; width: 100%; }
    input:focus, select:focus, button:focus-visible, [tabindex]:focus-visible {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
    }
    select {
      appearance: none;
      padding-right: 32px;
      background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position: calc(100% - 15px) 14px, calc(100% - 10px) 14px;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 17px; line-height: 1.2; }
    h2 { font-size: 18px; line-height: 1.25; }
    h3 { font-size: 13px; line-height: 1.3; }
    pre {
      margin: 0;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--code-bg);
      color: var(--code-fg);
      border-radius: 6px;
      padding: 12px;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 700; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--surface-hover); }
    tbody tr.selected { background: var(--accent-soft); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .skip-link { position: fixed; top: 8px; left: 8px; transform: translateY(-150%); z-index: 100; background: var(--surface); padding: 8px 12px; border: 1px solid var(--accent); border-radius: 6px; }
    .skip-link:focus { transform: translateY(0); }
    .hidden { display: none !important; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .error { color: var(--danger); }
    .ok { color: var(--success); }
    .app-shell { min-height: 100vh; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    .sidebar {
      min-width: 0;
      padding: 16px 12px;
      border-right: 1px solid var(--line);
      background: var(--surface);
      display: flex;
      flex-direction: column;
      gap: 18px;
      position: sticky;
      top: 0;
      height: 100vh;
      z-index: 10;
    }
    .brand { display: flex; align-items: center; gap: 10px; padding: 2px 6px; }
    .brand-mark { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 7px; background: var(--accent); color: white; font-weight: 800; }
    .brand-copy span { display: block; color: var(--muted); font-size: 10px; margin-top: 2px; text-transform: uppercase; }
    .nav { display: grid; gap: 4px; }
    .nav-item { min-height: 38px; border-color: transparent; background: transparent; color: var(--ink-secondary); text-align: left; font-weight: 650; }
    .nav-item:hover { background: var(--surface-hover); color: var(--ink); }
    .nav-item.active { background: var(--accent-soft); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 22%, transparent); }
    .sidebar-status { margin-top: auto; padding: 10px; border-top: 1px solid var(--line); color: var(--muted); }
    .status-line { display: flex; align-items: center; gap: 8px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
    .status-dot.online { background: var(--success); box-shadow: 0 0 0 3px var(--accent-soft); }
    .main-shell { min-width: 0; display: flex; flex-direction: column; }
    .topbar {
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--surface) 94%, transparent);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 8;
    }
    .page-heading { min-width: 0; }
    .page-heading p { color: var(--muted); font-size: 11px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .topbar-actions { display: flex; align-items: center; gap: 7px; }
    .content { min-width: 0; padding: 16px 18px 22px; }
    .view { display: none; min-width: 0; }
    .view.active { display: block; }
    .notice { margin-bottom: 12px; padding: 9px 11px; border: 1px solid var(--danger); border-radius: 6px; background: var(--danger-soft); }
    .section-head { min-height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .section-head p { color: var(--muted); font-size: 11px; margin-top: 2px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
    .metric-card { min-width: 0; min-height: 82px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); padding: 11px 12px; }
    .metric-card span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 8px; }
    .metric-card strong { display: block; font-size: 24px; line-height: 1; overflow: hidden; text-overflow: ellipsis; }
    .metric-card small { display: block; color: var(--muted); margin-top: 7px; }
    .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .75fr); gap: 12px; }
    .data-panel { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); overflow: hidden; }
    .data-panel-head { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
    .data-panel-body { padding: 12px; }
    .chart { height: 180px; display: flex; align-items: flex-end; gap: 4px; padding-top: 14px; border-bottom: 1px solid var(--line); }
    .chart-bar-wrap { flex: 1 1 0; min-width: 3px; height: 100%; display: flex; align-items: flex-end; }
    .chart-bar { width: 100%; min-height: 2px; border-radius: 3px 3px 0 0; background: var(--accent); opacity: .84; }
    .chart-caption { display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; margin-top: 7px; }
    .source-list { display: grid; gap: 11px; }
    .source-row { display: grid; grid-template-columns: 92px minmax(0, 1fr) 44px; gap: 8px; align-items: center; }
    .source-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .progress-track { height: 7px; border-radius: 4px; background: var(--surface-soft); overflow: hidden; }
    .progress-fill { height: 100%; border-radius: inherit; background: var(--blue); }
    .source-count { text-align: right; color: var(--muted); }
    .namespace-list { display: grid; gap: 9px; }
    .namespace-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 8px; align-items: start; padding: 8px 0; border-bottom: 1px solid var(--line); }
    .namespace-row:last-child { border-bottom: 0; }
    .namespace-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .namespace-meta { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
    .queue-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .queue-item { padding: 10px; background: var(--surface-soft); border-radius: 6px; }
    .queue-item strong, .queue-item span { display: block; }
    .queue-item span { color: var(--muted); font-size: 10px; margin-top: 4px; }
    .token-chart { display: flex; align-items: stretch; gap: 12px; min-height: 300px; padding: 24px 20px 12px; overflow-x: auto; border-top: 1px solid var(--line); }
    .token-chart-month { display: flex; flex: 0 0 92px; min-height: 260px; flex-direction: column; justify-content: flex-end; align-items: center; gap: 8px; }
    .token-chart-bars { display: flex; align-items: flex-end; justify-content: center; gap: 5px; height: 220px; width: 100%; border-bottom: 1px solid var(--line-strong); }
    .token-chart-bar { width: 20px; min-height: 2px; border-radius: 4px 4px 0 0; cursor: help; transition: opacity .15s ease; }
    .token-chart-bar:hover { opacity: .72; }
    .token-chart-bar.pi { background: var(--accent); }
    .token-chart-bar.codex { background: var(--blue); }
    .token-chart-bar.claude_code { background: var(--violet); }
    .token-chart-label { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .token-chart-value { font-size: 10px; color: var(--ink-secondary); white-space: nowrap; }
    .token-chart-empty { width: 100%; display: grid; place-items: center; color: var(--muted); }
    .pipeline { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .pipeline-stage { padding: 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-soft); }
    .pipeline-stage strong, .pipeline-stage span { display: block; }
    .pipeline-stage strong { font-size: 20px; margin: 6px 0; }
    .pipeline-stage span, .pipeline-stage small { color: var(--muted); }
    .audit-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
    .toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 120px 130px 140px auto auto; gap: 7px; align-items: center; margin-bottom: 10px; }
    .workspace { display: grid; grid-template-columns: minmax(500px, 1.15fr) minmax(420px, .85fr); gap: 10px; height: calc(100vh - 150px); min-height: 500px; }
    .panel { min-width: 0; height: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); overflow: hidden; display: flex; flex-direction: column; }
    .panel-head { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--surface-soft); }
    .panel-actions { display: flex; gap: 6px; }
    .table-wrap { flex: 1; min-height: 0; overflow: auto; }
    .detail-body { flex: 1; min-height: 0; padding: 12px; overflow: auto; }
    .detail-body pre { max-height: 360px; }
    .detail-section { margin-bottom: 16px; }
    .detail-section:last-child { margin-bottom: 0; }
    .detail-section h3 { margin-bottom: 7px; color: var(--muted); }
    .detail-summary { font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .detail-field { padding: 9px; border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
    .detail-field span, .detail-field strong { display: block; }
    .detail-field span { color: var(--muted); font-size: 10px; margin-bottom: 4px; }
    .detail-field strong { overflow-wrap: anywhere; }
    .footer { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--line); background: var(--surface-soft); color: var(--muted); }
    .pager { display: flex; align-items: center; gap: 6px; }
    .pager input { width: 48px; min-height: 28px; text-align: center; padding: 0 6px; }
    .pager button { min-width: 28px; min-height: 28px; padding: 0; }
    .pill { display: inline-flex; align-items: center; min-height: 21px; padding: 0 7px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); color: var(--ink-secondary); font-size: 10px; line-height: 19px; vertical-align: middle; white-space: nowrap; }
    .layer-L1 { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 38%, var(--line)); background: var(--blue-soft); }
    .layer-L2 { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 38%, var(--line)); background: var(--accent-soft); }
    .layer-L3 { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 38%, var(--line)); background: var(--amber-soft); }
    .layer-Skill { color: var(--violet); border-color: color-mix(in srgb, var(--violet) 38%, var(--line)); background: var(--violet-soft); }
    .status-deleted, .status-archived, .status-failed, .status-dead_letter { color: var(--danger); }
    .status-activated, .status-succeeded, .status-ok { color: var(--success); }
    .memory-title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .memory-summary { margin-top: 4px; color: var(--ink-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .memory-id { margin-top: 4px; color: var(--muted); font-size: 10px; white-space: normal; overflow-wrap: anywhere; }
    .tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
    .empty { padding: 26px 18px; color: var(--muted); text-align: center; }
    .task-list { flex: 1; overflow: auto; }
    .task-item { width: 100%; min-height: 70px; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; text-align: left; background: transparent; }
    .task-item.selected { background: var(--accent-soft); }
    .task-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); margin-top: 7px; font-size: 10px; }
    .system-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .system-list { display: grid; gap: 8px; }
    .system-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .system-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .system-row span { color: var(--muted); }
    .model-list { display: grid; gap: 8px; }
    .model-item { display: flex; justify-content: space-between; gap: 10px; padding: 9px; border: 1px solid var(--line); border-radius: 6px; }
    .review-list { display: grid; gap: 8px; }
    .review-card { padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
    .review-card-head, .review-card-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .review-card h4 { margin: 0; font-size: 13px; }
    .review-card p { margin: 9px 0; color: var(--ink-secondary); line-height: 1.55; white-space: pre-wrap; }
    .review-card-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .review-card-actions { justify-content: flex-end; margin-top: 10px; }
    .context-pack-head { align-items: flex-start; }
    .context-pack-head > div:first-child { min-width: 0; }
    .context-pack-controls { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .context-pack-controls select { width: min(260px, 100%); }
    .context-pack-tabs { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-soft); }
    .context-pack-tab { min-height: 28px; padding: 0 10px; border: 0; background: transparent; color: var(--muted); }
    .context-pack-tab.active { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(20, 35, 30, .08); }
    .context-pack-view { min-height: 260px; max-height: 520px; overflow: auto; }
    .context-outline { display: grid; gap: 16px; }
    .context-outline-pack { display: grid; gap: 12px; }
    .context-outline-pack + .context-outline-pack { padding-top: 16px; border-top: 1px solid var(--line); }
    .context-outline-title { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .context-outline-title span { color: var(--muted); font-size: 10px; }
    .context-outline-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .context-outline-section { min-width: 0; border-left: 2px solid var(--line-strong); padding-left: 10px; }
    .context-outline-section h4 { margin: 0 0 6px; font-size: 11px; color: var(--muted); }
    .context-item { width: 100%; min-height: 0; padding: 7px 8px; border: 0; border-radius: 5px; background: transparent; text-align: left; }
    .context-item:hover { background: var(--surface-hover); }
    .context-item strong, .context-item span { display: block; overflow-wrap: anywhere; }
    .context-item span { margin-top: 3px; color: var(--muted); font-size: 10px; }
    .context-graph { min-width: 760px; padding: 8px 4px; }
    .context-graph-pack { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(170px, .8fr) minmax(320px, 2fr); gap: 28px; align-items: center; padding: 18px 0; }
    .context-graph-pack + .context-graph-pack { border-top: 1px solid var(--line); }
    .graph-root, .graph-section, .graph-node { position: relative; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
    .graph-root { padding: 12px; border-color: var(--accent); background: var(--accent-soft); font-weight: 750; }
    .graph-branches, .graph-leaves { display: grid; gap: 8px; }
    .graph-section { padding: 8px 10px; color: var(--ink-secondary); font-size: 11px; }
    .graph-node { width: 100%; min-height: 34px; padding: 7px 9px; text-align: left; }
    .graph-root::after, .graph-section::before, .graph-section::after, .graph-node::before { content: ""; position: absolute; top: 50%; height: 1px; background: var(--line-strong); }
    .graph-root::after { left: 100%; width: 28px; }
    .graph-section::before, .graph-node::before { right: 100%; width: 28px; }
    .graph-section::after { left: 100%; width: 28px; }
    .context-markdown { max-height: none; min-height: 260px; }
    .dialog-screen { position: fixed; inset: 0; z-index: 45; display: grid; place-items: center; padding: 18px; background: rgba(10, 18, 15, .48); }
    .dialog { width: min(680px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); box-shadow: var(--shadow); }
    .dialog-head, .dialog-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
    .dialog-body { display: grid; gap: 12px; padding: 14px; }
    .dialog-actions { justify-content: flex-end; border-top: 1px solid var(--line); border-bottom: 0; }
    .dialog label { display: grid; gap: 6px; font-weight: 700; }
    .dialog textarea { width: 100%; min-height: 220px; resize: vertical; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .context-detail-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
    .auth-screen { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 18px; background: color-mix(in srgb, var(--canvas) 92%, transparent); backdrop-filter: blur(14px); }
    .auth-dialog { width: min(420px, 100%); border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); box-shadow: var(--shadow); padding: 20px; }
    .auth-dialog .brand { padding: 0; margin-bottom: 18px; }
    .auth-dialog label { display: block; margin-bottom: 7px; font-weight: 700; }
    .auth-dialog p { color: var(--muted); line-height: 1.5; margin: 7px 0 16px; }
    .auth-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
    .toast { position: fixed; right: 18px; bottom: 18px; z-index: 60; max-width: min(380px, calc(100vw - 36px)); padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface-raised); box-shadow: var(--shadow); }
    @media (max-width: 1180px) {
      .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .dashboard-grid { grid-template-columns: 1fr; }
      .workspace { grid-template-columns: 1fr; height: auto; }
      .panel { height: auto; min-height: 420px; }
      .table-wrap, .task-list { max-height: 460px; }
    }
    @media (max-width: 820px) {
      .app-shell { display: block; }
      .sidebar { position: sticky; top: 0; width: 100%; height: auto; padding: 8px 10px; border-right: 0; border-bottom: 1px solid var(--line); gap: 8px; }
      .brand { display: none; }
      .nav { display: flex; overflow-x: auto; gap: 4px; scrollbar-width: none; }
      .nav::-webkit-scrollbar { display: none; }
      .nav-item { min-width: max-content; text-align: center; }
      .sidebar-status { display: none; }
      .topbar { top: 51px; padding: 9px 12px; }
      .content { padding: 12px; }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .toolbar input:first-child { grid-column: 1 / -1; }
      .system-grid { grid-template-columns: 1fr; }
      .context-outline-sections { grid-template-columns: 1fr; }
      .context-pack-head { display: grid; }
    }
    @media (max-width: 560px) {
      .topbar-actions button:not(.icon-button) { padding: 0 8px; }
      .page-heading p { display: none; }
      .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-card { min-height: 76px; padding: 9px; }
      .metric-card strong { font-size: 21px; }
      .toolbar { grid-template-columns: 1fr; }
      .toolbar input:first-child { grid-column: auto; }
      .queue-grid, .detail-grid { grid-template-columns: 1fr; }
      .workspace { min-height: 0; }
      .panel { min-height: 360px; }
      th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; }
      .source-row { grid-template-columns: 76px minmax(0, 1fr) 38px; }
      .footer { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#mainContent">跳到主内容</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="主导航">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div class="brand-copy"><h1>Memmy</h1><span>Memory Console</span></div>
      </div>
      <nav class="nav" role="tablist" aria-label="控制台视图">
        <button id="navDashboard" class="nav-item active" role="tab" aria-selected="true">概览</button>
        <button id="navMemories" class="nav-item" role="tab" aria-selected="false">记忆</button>
        <button id="navActivity" class="nav-item" role="tab" aria-selected="false">活动</button>
        <button id="navTasks" class="nav-item" role="tab" aria-selected="false">任务</button>
        <button id="navTokenStats" class="nav-item" role="tab" aria-selected="false">Token 用量</button>
        <button id="navAudit" class="nav-item" role="tab" aria-selected="false">治理审计</button>
        <button id="navSystem" class="nav-item" role="tab" aria-selected="false">系统</button>
      </nav>
      <div class="sidebar-status">
        <div class="status-line"><span id="sidebarStatusDot" class="status-dot"></span><span id="sidebarStatusText">正在连接</span></div>
        <div id="sidebarVersion" class="mono" style="margin-top:7px;font-size:10px"></div>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="page-heading">
          <h2 id="pageTitle">Memory 概览</h2>
          <p id="pageSubtitle">存储、检索与演化状态</p>
        </div>
        <div class="topbar-actions">
          <button id="refresh" class="primary">刷新</button>
          <button id="themeToggle" class="icon-button" title="切换主题" aria-label="切换主题">◐</button>
          <button id="lockConsole" class="icon-button" title="锁定控制台" aria-label="锁定控制台">×</button>
        </div>
      </header>
      <main id="mainContent" class="content">
        <div id="errorMessage" class="notice error hidden" role="alert"></div>

        <section id="viewDashboard" class="view active" role="tabpanel">
          <div class="metrics-grid" id="stats" aria-label="记忆层统计"></div>
          <div class="metrics-grid" id="analysisMetrics" aria-label="检索统计"></div>
          <div class="dashboard-grid">
            <section class="data-panel" aria-labelledby="activityHeading">
              <div class="data-panel-head"><h3 id="activityHeading">30 天写入</h3><span id="activityTotal" class="muted mono"></span></div>
              <div class="data-panel-body"><div id="activityChart" class="chart" aria-label="每日记忆写入图"></div><div id="activityCaption" class="chart-caption"></div></div>
            </section>
            <section class="data-panel" aria-labelledby="sourceHeading">
              <div class="data-panel-head"><h3 id="sourceHeading">Agent 来源</h3><span id="sourceTotal" class="muted mono"></span></div>
              <div id="sourceDistribution" class="data-panel-body source-list"></div>
            </section>
            <section class="data-panel" aria-labelledby="namespaceHeading">
              <div class="data-panel-head"><h3 id="namespaceHeading">项目 / Workspace</h3><span id="namespaceTotal" class="muted mono"></span></div>
              <div id="namespaceDistribution" class="data-panel-body namespace-list"></div>
            </section>
            <section class="data-panel" aria-labelledby="queueHeading">
              <div class="data-panel-head"><h3 id="queueHeading">处理队列</h3><span id="queueState" class="muted"></span></div>
              <div id="queueSummary" class="data-panel-body queue-grid"></div>
            </section>
            <section class="data-panel" aria-labelledby="recentHeading">
              <div class="data-panel-head"><h3 id="recentHeading">最近变化</h3><button id="openActivity" class="ghost">查看全部</button></div>
              <div id="recentActivity" class="data-panel-body system-list"></div>
            </section>
            <section class="data-panel" style="grid-column:1 / -1" aria-labelledby="evolutionHeading">
              <div class="data-panel-head"><div><h3 id="evolutionHeading">L1 → L2 → L3 → Skill 演化流水线</h3><div id="l2ResolvingReason" class="muted" style="margin-top:3px"></div></div><span id="evolutionJobState" class="muted"></span></div>
              <div id="evolutionPipeline" class="data-panel-body pipeline"></div>
            </section>
            <section class="data-panel" style="grid-column:1 / -1" aria-labelledby="reviewHeading">
              <div class="data-panel-head"><div><h3 id="reviewHeading">待审核提炼</h3><span id="reviewCount" class="muted"></span></div><button id="bulkApproveCandidates">批准全部高置信度</button></div>
              <div id="reviewCandidates" class="data-panel-body review-list"></div>
            </section>
            <section class="data-panel" style="grid-column:1 / -1" aria-labelledby="contextPackHeading">
              <div class="data-panel-head context-pack-head"><div><h3 id="contextPackHeading">项目上下文包</h3><div class="muted" style="margin-top:3px">由原始记忆实时生成</div></div><div class="context-pack-controls"><select id="contextPackScope" aria-label="上下文包项目 / Workspace"><option value="">全部项目</option></select><div class="context-pack-tabs" role="tablist" aria-label="上下文包视图"><button id="contextPackOutlineTab" class="context-pack-tab active" role="tab" aria-selected="true">知识大纲</button><button id="contextPackGraphTab" class="context-pack-tab" role="tab" aria-selected="false">关系图</button><button id="contextPackMarkdownTab" class="context-pack-tab" role="tab" aria-selected="false">Markdown</button></div><button id="copyContextPack" class="ghost">复制</button><button id="exportContextPack" class="ghost">导出</button></div></div>
              <div class="data-panel-body"><div id="contextPackOutline" class="context-pack-view"></div><div id="contextPackGraph" class="context-pack-view hidden"></div><pre id="contextPackMarkdown" class="context-pack-view context-markdown hidden"></pre></div>
            </section>
            <section class="data-panel" aria-labelledby="isolationAuditHeading">
              <div class="data-panel-head"><h3 id="isolationAuditHeading">来源与项目隔离审计</h3><span id="auditRiskState" class="muted"></span></div>
              <div id="isolationAudit" class="data-panel-body audit-summary"></div>
            </section>
          </div>
        </section>

        <section id="viewMemories" class="view" role="tabpanel">
          <div class="toolbar" aria-label="记忆筛选">
            <input id="query" aria-label="搜索记忆" placeholder="搜索标题、内容或 ID">
            <select id="layer" aria-label="记忆层">
              <option value="">全部层</option><option value="L1">L1</option><option value="L2">L2</option><option value="L3">L3</option><option value="Skill">Skill</option>
            </select>
            <select id="status" aria-label="状态">
              <option value="">活动状态</option><option value="activated">已激活</option><option value="resolving">处理中</option><option value="archived">已归档</option><option value="deleted">已删除</option>
            </select>
            <select id="sourceAgent" aria-label="Agent 来源"><option value="">全部来源</option></select>
            <select id="projectScope" aria-label="项目 / Workspace"><option value="">全部项目</option></select>
            <button id="search">搜索</button>
            <button id="clearFilters">清除</button>
          </div>
          <div class="workspace">
            <section class="panel" aria-labelledby="memoryListHeading">
              <div class="panel-head"><h3 id="memoryListHeading">Memories</h3><span id="listMeta" class="muted">等待加载</span></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th style="width:76px">层</th><th>记忆</th><th style="width:108px">状态</th><th style="width:132px">更新时间</th></tr></thead>
                  <tbody id="memoryRows"></tbody>
                </table>
                <div id="emptyState" class="empty hidden">没有匹配的记忆</div>
              </div>
              <div class="footer"><span id="memoryResultSummary"></span><div class="pager"><button id="prevPage" aria-label="上一页">‹</button><input id="pageInput" class="mono" inputmode="numeric" aria-label="页码" value="1"><span class="mono">/</span><span id="totalPagesText" class="mono">1</span><button id="nextPage" aria-label="下一页">›</button></div></div>
            </section>
            <aside class="panel" aria-labelledby="detailTitle">
              <div class="panel-head"><div style="min-width:0"><h3 id="detailTitle">选择一条记忆</h3><div id="detailId" class="memory-id mono"></div></div><div class="panel-actions"><button id="markUseful" disabled>有用</button><button id="markNotUseful" disabled>没用</button><button id="mergeMemory" disabled>合并</button><button id="promoteMemory" disabled>提升 L2</button><button id="archiveMemory" disabled>归档</button><button id="copyJson">复制</button><button id="deleteMemory" class="danger" disabled>删除</button></div></div>
              <div id="detailBody" class="detail-body"><div id="detailContent" class="empty">从左侧选择记忆</div><pre id="detailJson" class="hidden">{}</pre></div>
            </aside>
          </div>
        </section>

        <section id="viewActivity" class="view" role="tabpanel">
          <div class="toolbar" style="grid-template-columns:minmax(220px,1fr) 180px 160px auto auto">
            <input id="activityQuery" aria-label="筛选活动" placeholder="筛选 Agent、工具或内容">
            <select id="activityTool" aria-label="工具"><option value="">全部工具</option><option value="memory_add">memory_add</option><option value="memory_search">memory_search</option><option value="skill_generate">skill_generate</option><option value="skill_evolve">skill_evolve</option></select>
            <select id="activitySource" aria-label="Agent 来源"><option value="">全部来源</option></select>
            <button id="loadActivity">筛选</button><button id="clearActivity">清除</button>
          </div>
          <div class="workspace">
            <section class="panel"><div class="panel-head"><h3>API 活动</h3><span id="activityMeta" class="muted"></span></div><div class="table-wrap"><table><thead><tr><th style="width:150px">时间</th><th style="width:142px">工具</th><th>Agent / 结果</th><th style="width:90px">耗时</th></tr></thead><tbody id="activityRows"></tbody></table><div id="activityEmpty" class="empty hidden">没有活动记录</div></div></section>
            <aside class="panel"><div class="panel-head"><div><h3 id="activityDetailTitle">选择一条活动</h3><div id="activityDetailId" class="memory-id mono"></div></div><button id="copyActivity">复制</button></div><div class="detail-body"><pre id="activityDetailJson">{}</pre></div></aside>
          </div>
        </section>

        <section id="viewTasks" class="view" role="tabpanel">
          <div class="toolbar" style="grid-template-columns:minmax(220px,1fr) auto auto">
            <input id="taskQuery" aria-label="搜索任务" placeholder="搜索任务或对话"><button id="searchTasks">搜索</button><button id="clearTasks">清除</button>
          </div>
          <div class="workspace">
            <section class="panel"><div class="panel-head"><h3>Episodes</h3><span id="taskMeta" class="muted"></span></div><div id="taskRows" class="task-list"></div><div id="taskEmpty" class="empty hidden">没有任务记录</div><div class="footer"><span id="taskResultSummary"></span><div class="pager"><button id="prevTaskPage" aria-label="上一页">‹</button><span id="taskPageText" class="mono">1 / 1</span><button id="nextTaskPage" aria-label="下一页">›</button></div></div></section>
            <aside class="panel"><div class="panel-head"><div><h3 id="taskDetailTitle">选择一个任务</h3><div id="taskDetailId" class="memory-id mono"></div></div><div class="panel-actions"><button id="copyTask">复制</button><button id="deleteTask" class="danger" disabled>删除</button></div></div><div class="detail-body"><div id="taskDetailContent" class="empty">从左侧选择任务</div><pre id="taskDetailJson" class="hidden">{}</pre></div></aside>
          </div>
        </section>

        <section id="viewTokenStats" class="view" role="tabpanel">
          <div class="section-head"><div><h2>Agent Token 用量统计</h2><p>Pi、Codex、Claude Code 各 Agent 的 Token 消耗</p></div></div>
          <div class="system-grid">
            <section class="data-panel" style="grid-column:1 / -1">
              <div class="data-panel-head"><h3>选择项目</h3><span class="muted">按月 Token 用量</span></div>
              <div class="data-panel-body"><select id="tokenStatsProject" aria-label="项目" style="max-width:720px"></select></div>
            </section>
            <section class="data-panel" style="grid-column:1 / -1">
              <div class="data-panel-head"><h3>月度用量</h3><div id="tokenStatsLegend" class="tag-list"></div></div>
              <div id="tokenStatsChart" class="token-chart"></div>
            </section>
            <section class="data-panel" style="grid-column:1 / -1">
              <div class="data-panel-head"><h3>项目累计</h3></div>
              <div id="tokenStatsCombined" class="data-panel-body queue-grid"></div>
            </section>
            <section class="data-panel" style="grid-column:1 / -1">
              <div class="data-panel-body"><small id="tokenStatsScannedAt" class="muted"></small></div>
            </section>
          </div>
        </section>

        <section id="viewAudit" class="view" role="tabpanel">
          <div class="section-head"><div><h2>Agent 来源与项目隔离审计</h2><p>检查缺失 workspace、未知来源、旧来源标签与跨项目泄漏风险</p></div><span id="auditIssueCount" class="pill"></span></div>
          <div class="system-grid">
            <section class="data-panel" style="grid-column:1 / -1"><div class="data-panel-head"><h3>审计问题</h3><span class="muted">最多显示 500 条</span></div><div class="table-wrap"><table><thead><tr><th>Memory</th><th>问题</th><th>Project / Workspace</th><th>Source</th></tr></thead><tbody id="auditRows"></tbody></table><div id="auditEmpty" class="empty hidden">未发现来源或隔离问题</div></div></section>
            <section class="data-panel" style="grid-column:1 / -1"><div class="data-panel-head"><h3>Workspace 上下文包</h3><button id="copyAuditPacks">复制全部</button></div><div class="data-panel-body"><pre id="auditPacks" style="max-height:420px"></pre></div></section>
          </div>
        </section>

        <section id="viewSystem" class="view" role="tabpanel">
          <div class="section-head"><div><h2>系统状态</h2><p>服务、存储、模型与脱敏配置</p></div><div class="topbar-actions"><button id="runWorker">运行 Worker</button><button id="retryFailed">重试失败</button><button id="promoteCandidates">提升候选</button><button id="reloadConfig">重新加载配置</button></div></div>
          <div class="system-grid">
            <section class="data-panel"><div class="data-panel-head"><h3>Memory 服务</h3><span id="systemHealthBadge" class="pill"></span></div><div id="systemHealth" class="data-panel-body system-list"></div></section>
            <section class="data-panel"><div class="data-panel-head"><h3>存储</h3><span id="systemSchema" class="muted mono"></span></div><div id="systemStorage" class="data-panel-body system-list"></div></section>
            <section class="data-panel"><div class="data-panel-head"><h3>模型</h3><span class="muted">运行配置</span></div><div id="systemModels" class="data-panel-body model-list"></div></section>
            <section class="data-panel"><div class="data-panel-head"><h3>队列</h3><span class="muted">实时计数</span></div><div id="systemQueues" class="data-panel-body queue-grid"></div></section>
            <section class="data-panel" style="grid-column:1 / -1"><div class="data-panel-head"><h3>脱敏配置</h3><button id="copyConfig">复制</button></div><div class="data-panel-body"><pre id="configJson">{}</pre></div></section>
          </div>
        </section>
      </main>
    </div>
  </div>
  <div id="contextMemoryDialog" class="dialog-screen hidden" role="dialog" aria-modal="true" aria-labelledby="contextMemoryDialogTitle">
    <div class="dialog">
      <div class="dialog-head"><div><h3 id="contextMemoryDialogTitle">记忆详情</h3><div id="contextMemoryDialogId" class="memory-id mono"></div></div><button id="closeContextMemoryDialog" class="icon-button" aria-label="关闭" title="关闭">×</button></div>
      <div id="contextMemoryDetail" class="dialog-body"></div>
      <form id="contextMemoryEditForm" class="hidden">
        <div class="dialog-body"><div class="muted">保存会修改原始记忆，并重新生成上下文包。</div><label>标题<input id="contextMemoryTitle" required></label><label>标签<input id="contextMemoryTags" placeholder="用逗号分隔"></label><label>正文<textarea id="contextMemoryBody" required></textarea></label></div>
        <div class="dialog-actions"><button id="cancelContextMemoryEdit" type="button">取消</button><button id="saveContextMemory" type="submit" class="primary">保存并重新生成</button></div>
      </form>
      <div id="contextMemoryDetailActions" class="dialog-actions"><button id="editContextMemory" class="primary">编辑原始记忆</button></div>
    </div>
  </div>

  <div id="authScreen" class="auth-screen hidden" role="dialog" aria-modal="true" aria-labelledby="authTitle">
    <div class="auth-dialog">
      <div class="brand"><div class="brand-mark">M</div><div class="brand-copy"><h1 id="authTitle">Memmy Memory</h1><span>Console Access</span></div></div>
      <label for="tokenInput">访问令牌</label>
      <input id="tokenInput" type="password" autocomplete="current-password" spellcheck="false">
      <p>令牌仅保存在当前浏览器会话中。</p>
      <div id="authError" class="error hidden" role="alert"></div>
      <div class="auth-actions"><button id="connectToken" class="primary">连接</button></div>
    </div>
  </div>
  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>

  <script>
    function resolveMemoryToken() {
      const hash = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
      const fragmentToken = hash ? new URLSearchParams(hash).get("token") : "";
      if (fragmentToken && typeof sessionStorage !== "undefined") sessionStorage.setItem("memmyMemoryToken", fragmentToken);
      if (fragmentToken && typeof history !== "undefined") history.replaceState(null, "", window.location.pathname + window.location.search);
      return fragmentToken || (typeof sessionStorage !== "undefined" ? sessionStorage.getItem("memmyMemoryToken") || "" : "");
    }

    let memoryToken = resolveMemoryToken();
    const state = {
      view: "dashboard",
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 1,
      selectedMemoryId: undefined,
      namespaceOptions: [],
      detailJson: {},
      selectedActivityId: undefined,
      activityJson: {},
      activityLogs: [],
      taskPage: 1,
      taskTotalPages: 1,
      selectedTaskId: undefined,
      taskJson: {},
      tasks: [],
      overview: {},
      analysis: {},
      metrics: {},
      status: {},
      config: {},
      evolution: {},
      reviewCandidates: [],
      contextPack: {},
      contextPackView: "outline",
      contextMemory: undefined,
      namespaceAudit: {},
      serviceActivity: {},
      tokenStats: { projects: [], scannedAt: "" },
      lastRequestMs: 0,
      toastTimer: undefined
    };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const viewMeta = {
      dashboard: ["Memory 概览", "存储、检索与演化状态"],
      memories: ["Memories", "搜索、检查与治理记忆"],
      activity: ["活动日志", "Codex、Pi 与工具调用"],
      tasks: ["任务与 Episodes", "对话批次、Turn 与关联记忆"],
      tokenStats: ["Token 用量", "Pi、Codex、Claude Code 各 Agent 的 Token 消耗"],
      audit: ["治理审计", "Agent 来源、Workspace 隔离与项目上下文包"],
      system: ["系统", "服务、存储、模型与配置"]
    };

    async function api(path, options = {}) {
      const started = Date.now();
      const headers = { ...(options.headers || {}), ...(memoryToken ? { authorization: "Bearer " + memoryToken } : {}) };
      if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
      const response = await fetch(path, { ...options, headers });
      state.lastRequestMs = Date.now() - started;
      const text = await response.text();
      let body = {};
      if (text) {
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
      }
      if (!response.ok) {
        if (response.status === 401) showAuth("令牌无效或已过期");
        const message = body.error && body.error.message ? body.error.message : text || response.statusText;
        throw new Error(message);
      }
      return body;
    }

    function clearError() { $("errorMessage").classList.add("hidden"); $("errorMessage").textContent = ""; }
    function showError(error) { $("errorMessage").classList.remove("hidden"); $("errorMessage").textContent = error.message || String(error); }
    function showToast(message) {
      $("toast").textContent = message;
      $("toast").classList.remove("hidden");
      if (state.toastTimer) clearTimeout(state.toastTimer);
      state.toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 2400);
    }
    function showAuth(message) {
      $("authScreen").classList.remove("hidden");
      $("authError").classList.toggle("hidden", !message);
      $("authError").textContent = message || "";
      setTimeout(() => $("tokenInput").focus(), 0);
    }
    function hideAuth() { $("authScreen").classList.add("hidden"); $("authError").classList.add("hidden"); }
    function formatNumber(value) { const number = Number(value || 0); return Number.isFinite(number) ? number.toLocaleString() : "0"; }
    function formatTokenCount(value) {
      const number = Number(value || 0);
      if (!Number.isFinite(number)) return "0";
      const absolute = Math.abs(number);
      const compact = (divisor, unit) => (number / divisor).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + unit;
      if (absolute >= 100000000) return compact(100000000, "亿");
      if (absolute >= 10000) return compact(10000, "万");
      if (absolute >= 1000) return compact(1000, "千");
      return number.toLocaleString("zh-CN");
    }
    function formatDate(value, withSeconds = false) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
    }
    function displayMemoryTitle(title, fallback) { const cleaned = String(title || "").replace(/^\\s*Summary:\\s*/i, "").trim(); return cleaned || fallback; }
    function valueAt(object, path, fallback = undefined) { let value = object; for (const key of path) value = value && typeof value === "object" ? value[key] : undefined; return value === undefined ? fallback : value; }
    function namespaceLabel(namespace) { return namespace && namespace.label ? namespace.label : namespace && namespace.projectId ? namespace.projectId : "unscoped"; }
    function namespaceMeta(namespace) {
      if (!namespace) return "tenant local · project unscoped";
      const bits = ["tenant " + (namespace.tenantId || "local"), "project " + (namespace.projectId || "unscoped")];
      if (namespace.workspacePath) bits.push(namespace.workspacePath);
      else if (namespace.workspaceId) bits.push(namespace.workspaceId);
      return bits.join(" · ");
    }
    function namespaceOptionValue(namespace) {
      if (!namespace) return "";
      if (namespace.workspaceId) return "workspace:" + namespace.workspaceId;
      if (namespace.projectId) return "project:" + namespace.projectId;
      return "";
    }
    function jsonText(value) { return JSON.stringify(value || {}, null, 2); }
    function copyJson(value) { return navigator.clipboard.writeText(jsonText(value)).then(() => showToast("已复制")); }
    function requestBody(reason) { return JSON.stringify({ requestId: "panel-" + Date.now(), adapterId: "memory-console", reason }); }

    function setView(view) {
      state.view = view;
      for (const name of Object.keys(viewMeta)) {
        const active = name === view;
        $("view" + name[0].toUpperCase() + name.slice(1)).classList.toggle("active", active);
        const nav = $("nav" + name[0].toUpperCase() + name.slice(1));
        nav.classList.toggle("active", active);
        nav.setAttribute("aria-selected", String(active));
      }
      $("pageTitle").textContent = viewMeta[view][0];
      $("pageSubtitle").textContent = viewMeta[view][1];
      refreshCurrentView();
    }

    function renderStats(overview) {
      const counts = overview.counts || {};
      $("stats").innerHTML = [
        ["L1 记忆", counts.memories, "原始与摘要"],
        ["L2 经验", counts.experiences, "策略与经验"],
        ["L3 世界模型", counts.worldModels, "长期模型"],
        ["Skills", counts.skills, "可复用能力"]
      ].map((item) => '<div class="metric-card"><span>' + esc(item[0]) + '</span><strong>' + esc(formatNumber(item[1])) + '</strong><small>' + esc(item[2]) + '</small></div>').join("");
      renderLayerFilter(overview);
    }

    function renderAnalysis(analysis) {
      const metrics = analysis.metrics || {};
      $("analysisMetrics").innerHTML = [
        ["平均召回分", Number(metrics.avgRecallScore || 0).toFixed(2), formatNumber(metrics.recallEvents) + " 次检索"],
        ["活跃 Skills", metrics.activeSkills, formatNumber(metrics.recentlyUsedSkills) + " 个近期使用"],
        ["平均工具延迟", formatNumber(metrics.avgToolLatencyMs) + " ms", "所有 Memory 工具"],
        ["P95 延迟", formatNumber(metrics.p95ToolLatencyMs) + " ms", "最近 7 天"]
      ].map((item) => '<div class="metric-card"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong><small>' + esc(item[2]) + '</small></div>').join("");
    }

    function renderActivityChart(overview) {
      const points = (overview.dailyActivity || []).slice(-30);
      const maximum = Math.max(1, ...points.map((point) => Number(point.count || 0)));
      const total = points.reduce((sum, point) => sum + Number(point.count || 0), 0);
      $("activityTotal").textContent = formatNumber(total) + " writes";
      $("activityChart").innerHTML = points.map((point) => {
        const height = Math.max(2, Math.round((Number(point.count || 0) / maximum) * 100));
        return '<div class="chart-bar-wrap" title="' + esc(point.date) + ': ' + esc(point.count) + '"><div class="chart-bar" style="height:' + height + '%"></div></div>';
      }).join("");
      $("activityCaption").innerHTML = points.length ? '<span>' + esc(points[0].date) + '</span><span>' + esc(points[points.length - 1].date) + '</span>' : "";
    }

    function renderSources(overview) {
      const sources = (overview.sourceDistribution || []).slice(0, 8);
      const total = sources.reduce((sum, source) => sum + Number(source.count || 0), 0);
      $("sourceTotal").textContent = formatNumber(total);
      $("sourceDistribution").innerHTML = sources.length ? sources.map((source) =>
        '<div class="source-row"><span class="source-name" title="' + esc(source.source) + '">' + esc(source.source) + '</span><div class="progress-track"><div class="progress-fill" style="width:' + Math.max(2, Number(source.percentage || 0)) + '%"></div></div><span class="source-count mono">' + esc(source.count) + '</span></div>'
      ).join("") : '<div class="empty">暂无来源数据</div>';
      const options = ['<option value="">全部来源</option>'].concat((overview.sourceDistribution || []).map((source) => '<option value="' + esc(source.source) + '">' + esc(source.source) + '</option>')).join("");
      const currentMemorySource = $("sourceAgent").value;
      const currentActivitySource = $("activitySource").value;
      $("sourceAgent").innerHTML = options;
      $("activitySource").innerHTML = options;
      $("sourceAgent").value = currentMemorySource;
      $("activitySource").value = currentActivitySource;
    }

    function renderNamespaces(overview) {
      const allNamespaces = overview.namespaceDistribution || [];
      const namespaces = allNamespaces.slice(0, 8);
      const total = allNamespaces.reduce((sum, namespace) => sum + Number(namespace.count || 0), 0);
      $("namespaceTotal").textContent = formatNumber(total);
      $("namespaceDistribution").innerHTML = namespaces.length ? namespaces.map((namespace) =>
        '<div class="namespace-row"><div><strong class="namespace-title" title="' + esc(namespaceMeta(namespace)) + '">' + esc(namespaceLabel(namespace)) + '</strong><div class="namespace-meta mono">' + esc(namespaceMeta(namespace)) + '</div></div><span class="source-count mono">' + esc(namespace.count) + '</span></div>'
      ).join("") : '<div class="empty">暂无项目数据</div>';
      const currentProjectScope = $("projectScope").value;
      const options = ['<option value="">全部项目</option>'].concat(allNamespaces.map((namespace) => '<option value="' + esc(namespaceOptionValue(namespace)) + '">' + esc(namespaceLabel(namespace)) + '</option>')).join("");
      $("projectScope").innerHTML = options;
      $("projectScope").value = currentProjectScope;
      const currentContextScope = $("contextPackScope").value;
      $("contextPackScope").innerHTML = options;
      $("contextPackScope").value = currentContextScope;
    }

    function renderLayerFilter(overview) {
      const layerCounts = overview.layerCounts || (overview.stats && overview.stats.byLayer) || {};
      const currentLayer = $("layer").value;
      const options = [
        ["", "全部层"],
        ["L1", "L1"],
        ["L2", "L2"],
        ["L3", "L3"],
        ["Skill", "Skill"]
      ].map(([value, label]) => {
        const count = value ? Number(layerCounts[value] || 0) : 0;
        const suffix = value ? " (" + formatNumber(count) + ")" : "";
        return '<option value="' + esc(value) + '">' + esc(label + suffix) + '</option>';
      }).join("");
      $("layer").innerHTML = options;
      $("layer").value = currentLayer;
    }

    function renderQueues(metrics) {
      const jobs = metrics.jobs || {};
      const retries = metrics.embeddingRetries || {};
      const queued = Number(jobs.queued || 0);
      const failed = Number(jobs.failed || 0) + Number(jobs.dead_letter || 0);
      const embedding = Number(retries.pending || 0) + Number(retries.in_progress || 0);
      $("queueState").textContent = failed ? "需要检查" : queued || embedding ? "处理中" : "空闲";
      $("queueSummary").innerHTML = [
        [queued, "排队任务"], [embedding, "Embedding"], [failed, "失败任务"]
      ].map((item) => '<div class="queue-item"><strong>' + esc(formatNumber(item[0])) + '</strong><span>' + esc(item[1]) + '</span></div>').join("");
    }

    function renderEvolution(evolution) {
      const layers = evolution.layers || [];
      $("evolutionPipeline").innerHTML = layers.map((stage) =>
        '<div class="pipeline-stage"><span>' + esc(stage.layer) + '</span><strong>' + esc(formatNumber(stage.count)) + '</strong><small>' + esc(formatNumber(stage.candidates)) + ' 候选 · ' + esc(formatNumber(stage.queued)) + ' 排队 · ' + esc(formatNumber(stage.failed)) + ' 失败</small><small class="mono" style="display:block;margin-top:7px">最近：' + esc(stage.recentJob ? stage.recentJob.jobType + ' / ' + stage.recentJob.status + ' / ' + stage.recentJob.id : '无') + '</small></div>'
      ).join("") || '<div class="empty">暂无流水线数据</div>';
      $("l2ResolvingReason").textContent = valueAt(evolution, ["l2Resolving", "reason"], "");
      $("evolutionJobState").textContent = formatNumber((evolution.recentJobs || []).length) + " recent jobs";
    }

    function contextPackMarkdown(result, selectedScope = "") {
      const packs = result.packs || [];
      const visiblePacks = selectedScope
        ? packs.filter((pack) => namespaceOptionValue(pack.namespace) === selectedScope)
        : packs;
      return visiblePacks.length
        ? visiblePacks.map((pack) => pack.markdown).join("\\n\\n---\\n\\n")
        : "暂无项目上下文";
    }

    function exportContextPackMarkdown() {
      const markdown = contextPackMarkdown(state.contextPack || {}, $("contextPackScope").value);
      const selectedPack = visibleContextPacks(state.contextPack || {})[0];
      const name = selectedPack ? namespaceLabel(selectedPack.namespace).replace(/[^a-zA-Z0-9._-]+/g, "-") : "all-projects";
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "memmy-context-pack-" + name + ".md";
      link.click();
      URL.revokeObjectURL(url);
      showToast("Markdown 已导出");
    }

    const contextPackSections = [
      ["conventions", "当前项目约定"],
      ["commands", "常用命令"],
      ["architectureFacts", "架构事实"],
      ["recentTasks", "最近任务"],
      ["userPreferences", "用户偏好"]
    ];

    function visibleContextPacks(result) {
      const selectedScope = $("contextPackScope").value;
      const packs = result.packs || [];
      return selectedScope ? packs.filter((pack) => namespaceOptionValue(pack.namespace) === selectedScope) : packs;
    }

    function contextItemTitle(item) { return displayMemoryTitle(item.title || item.summary, item.id); }
    function contextItemDescription(item) { return item.summary && item.summary !== item.title ? item.summary : item.updatedAt ? "更新于 " + formatDate(item.updatedAt) : ""; }

    function renderContextOutline(packs) {
      $("contextPackOutline").innerHTML = packs.length ? '<div class="context-outline">' + packs.map((pack) => {
        const sections = contextPackSections.map(([key, label]) => {
          const items = Array.isArray(pack[key]) ? pack[key] : [];
          const content = items.length ? items.map((item) => '<button class="context-item" data-context-kind="' + (key === "recentTasks" ? "task" : "memory") + '" data-context-id="' + esc(item.id) + '"><strong>' + esc(contextItemTitle(item)) + '</strong>' + (contextItemDescription(item) ? '<span>' + esc(contextItemDescription(item)) + '</span>' : '') + '</button>').join("") : '<div class="muted" style="padding:7px 8px">暂无</div>';
          return '<section class="context-outline-section"><h4>' + esc(label) + ' · ' + formatNumber(items.length) + '</h4>' + content + '</section>';
        }).join("");
        return '<article class="context-outline-pack"><div class="context-outline-title"><h3>' + esc(namespaceLabel(pack.namespace)) + '</h3><span>' + esc(formatDate(pack.generatedAt, true)) + '</span></div><div class="context-outline-sections">' + sections + '</div></article>';
      }).join("") + '</div>' : '<div class="empty">暂无项目上下文</div>';
      bindContextNodes($("contextPackOutline"));
    }

    function renderContextGraph(packs) {
      $("contextPackGraph").innerHTML = packs.length ? '<div class="context-graph">' + packs.map((pack) => {
        const populated = contextPackSections.map(([key, label]) => [key, label, Array.isArray(pack[key]) ? pack[key] : []]).filter((section) => section[2].length);
        const branches = populated.map(([, label, items]) => '<div class="graph-section">' + esc(label) + ' · ' + formatNumber(items.length) + '</div>').join("");
        const leaves = populated.map(([key, , items]) => '<div class="graph-leaves">' + items.map((item) => '<button class="graph-node" data-context-kind="' + (key === "recentTasks" ? "task" : "memory") + '" data-context-id="' + esc(item.id) + '">' + esc(contextItemTitle(item)) + '</button>').join("") + '</div>').join("");
        return '<section class="context-graph-pack"><div class="graph-root">' + esc(namespaceLabel(pack.namespace)) + '</div><div class="graph-branches">' + (branches || '<div class="muted">暂无节点</div>') + '</div><div class="graph-leaves">' + leaves + '</div></section>';
      }).join("") + '</div>' : '<div class="empty">暂无项目上下文</div>';
      bindContextNodes($("contextPackGraph"));
    }

    function bindContextNodes(container) {
      for (const node of container.querySelectorAll("[data-context-id]")) {
        node.onclick = () => node.dataset.contextKind === "task" ? openContextTask(node.dataset.contextId) : openContextMemory(node.dataset.contextId);
      }
    }

    function contextTaskById(id) {
      for (const pack of visibleContextPacks(state.contextPack || {})) {
        const task = (pack.recentTasks || []).find((item) => item.id === id);
        if (task) return task;
      }
    }

    function showContextDialog() { $("contextMemoryDialog").classList.remove("hidden"); }
    function closeContextDialog() { $("contextMemoryDialog").classList.add("hidden"); state.contextMemory = undefined; }

    function openContextTask(id) {
      const task = contextTaskById(id);
      if (!task) return;
      state.contextMemory = undefined;
      $("contextMemoryDialogTitle").textContent = contextItemTitle(task);
      $("contextMemoryDialogId").textContent = task.id;
      $("contextMemoryDetail").innerHTML = '<div><strong>最近任务</strong><div class="muted" style="margin-top:5px">更新于 ' + esc(formatDate(task.updatedAt, true)) + '</div></div>';
      $("contextMemoryEditForm").classList.add("hidden");
      $("contextMemoryDetail").classList.remove("hidden");
      $("contextMemoryDetailActions").classList.add("hidden");
      showContextDialog();
    }

    async function openContextMemory(id) {
      if (!id) return;
      $("contextMemoryDialogTitle").textContent = "正在加载记忆";
      $("contextMemoryDialogId").textContent = id;
      $("contextMemoryDetail").innerHTML = '<div class="empty">正在加载</div>';
      $("contextMemoryEditForm").classList.add("hidden");
      $("contextMemoryDetail").classList.remove("hidden");
      $("contextMemoryDetailActions").classList.add("hidden");
      showContextDialog();
      try {
        const data = await api("/api/v1/memory/" + encodeURIComponent(id));
        const item = data.item || {};
        state.contextMemory = item;
        $("contextMemoryDialogTitle").textContent = contextItemTitle(item);
        $("contextMemoryDialogId").textContent = item.id || id;
        $("contextMemoryDetail").innerHTML = '<div class="context-detail-body">' + esc(item.body || item.summary || "暂无内容") + '</div><div class="tag-list">' + ((item.tags || []).map((tag) => '<span class="pill">' + esc(tag) + '</span>').join("") || '<span class="muted">无标签</span>') + '</div><div class="muted">来源 ' + esc(valueAt(item, ["metadata", "source"], "unknown")) + ' · v' + esc(item.version || 1) + ' · ' + esc(formatDate(item.updatedAt, true)) + '</div>';
        $("contextMemoryDetailActions").classList.remove("hidden");
      } catch (error) { closeContextDialog(); showError(error); }
    }

    function beginContextMemoryEdit() {
      const item = state.contextMemory;
      if (!item) return;
      $("contextMemoryTitle").value = contextItemTitle(item);
      $("contextMemoryTags").value = (item.tags || []).join(", ");
      $("contextMemoryBody").value = item.body || item.summary || "";
      $("contextMemoryDetail").classList.add("hidden");
      $("contextMemoryDetailActions").classList.add("hidden");
      $("contextMemoryEditForm").classList.remove("hidden");
      $("contextMemoryTitle").focus();
    }

    function cancelContextMemoryEdit() {
      $("contextMemoryEditForm").classList.add("hidden");
      $("contextMemoryDetail").classList.remove("hidden");
      $("contextMemoryDetailActions").classList.remove("hidden");
    }

    async function saveContextMemory(event) {
      event.preventDefault();
      const item = state.contextMemory;
      if (!item) return;
      const button = $("saveContextMemory");
      button.disabled = true;
      try {
        await api("/api/v1/memory/" + encodeURIComponent(item.id) + "/edit", { method: "POST", body: JSON.stringify({ requestId: "panel-" + Date.now(), adapterId: "memory-console", reason: "edited from generated context pack", title: $("contextMemoryTitle").value, tags: $("contextMemoryTags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), content: $("contextMemoryBody").value }) });
        closeContextDialog();
        await Promise.all([loadDashboard(), loadMemories()]);
        showToast("原始记忆已更新，上下文包已重新生成");
      } finally { button.disabled = false; }
    }

    function setContextPackView(view) {
      state.contextPackView = view;
      for (const name of ["outline", "graph", "markdown"]) {
        const active = name === view;
        $("contextPack" + name[0].toUpperCase() + name.slice(1)).classList.toggle("hidden", !active);
        const tab = $("contextPack" + name[0].toUpperCase() + name.slice(1) + "Tab");
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      }
    }

    function renderContextPack(result) {
      const packs = visibleContextPacks(result);
      $("contextPackMarkdown").textContent = contextPackMarkdown(result, $("contextPackScope").value);
      renderContextOutline(packs);
      renderContextGraph(packs);
      setContextPackView(state.contextPackView);
      $("auditPacks").textContent = contextPackMarkdown(result);
    }
    function renderNamespaceAudit(audit) {
      const summary = audit.summary || {};
      $("auditRiskState").textContent = Number(summary.crossWorkspaceRisk || 0) ? "存在风险" : "未发现泄漏风险";
      $("isolationAudit").innerHTML = [
        [summary.missingWorkspace, "无 Workspace"], [summary.unknownSource, "未知来源"],
        [summary.missingAgentSourceTag, "缺来源标签"], [summary.crossWorkspaceRisk, "跨 Workspace 风险"]
      ].map((item) => '<div class="queue-item"><strong>' + esc(formatNumber(item[0])) + '</strong><span>' + esc(item[1]) + '</span></div>').join("");
      const issues = audit.issues || [];
      $("auditIssueCount").textContent = formatNumber(issues.length) + " issues";
      $("auditEmpty").classList.toggle("hidden", issues.length > 0);
      $("auditRows").innerHTML = issues.map((issue) => '<tr><td class="mono">' + esc(issue.memoryId) + '</td><td><span class="pill status-' + esc(issue.severity) + '">' + esc(issue.issue) + '</span></td><td>' + esc((issue.projectId || "unscoped") + " / " + (issue.workspaceId || "none")) + '</td><td>' + esc(issue.source || "unknown") + '</td></tr>').join("");
    }

    function renderReviewCandidates(result) {
      const candidates = Array.isArray(result.items) ? result.items : [];
      state.reviewCandidates = candidates;
      $("reviewCount").textContent = candidates.length ? formatNumber(candidates.length) + " 条候选" : "暂无待审核内容";
      $("bulkApproveCandidates").disabled = !candidates.some((candidate) => Number(candidate.confidence || 0) >= 0.8);
      $("reviewCandidates").innerHTML = candidates.length ? candidates.map((candidate) => {
        const evidence = candidate.evidence || {};
        const confidence = Number(candidate.confidence || 0);
        const evidenceIds = Array.isArray(evidence.ids) ? evidence.ids : [];
        return '<article class="review-card" data-review-id="' + esc(candidate.id) + '">' +
          '<div class="review-card-head"><h4>' + esc(candidate.title || candidate.suggestedLayer || "候选提炼") + '</h4><div class="review-card-meta"><span class="pill layer-' + esc(candidate.suggestedLayer) + '">' + esc(candidate.suggestedLayer || "-") + '</span><span class="pill status-' + esc(candidate.confidenceLabel || "low") + '">' + esc(candidate.confidenceLabel || "low") + ' ' + esc(Math.round(confidence * 100)) + '%</span><span class="pill">风险 ' + esc(candidate.risk || "-") + '</span></div></div>' +
          '<p>' + esc(candidate.conclusion || "") + '</p>' +
          '<div class="muted">' + esc(formatNumber(evidence.episodeCount)) + ' episodes · ' + esc(formatNumber(evidence.l1Count)) + ' L1 evidence' + (evidenceIds.length ? ' · ' + esc(evidenceIds.join(", ")) : "") + '</div>' +
          '<div class="review-card-actions"><button data-review-action="reject" data-review-id="' + esc(candidate.id) + '" class="ghost">拒绝</button><button data-review-action="edit" data-review-id="' + esc(candidate.id) + '" class="ghost">修改后批准</button><button data-review-action="approve" data-review-id="' + esc(candidate.id) + '">批准</button></div>' +
        '</article>';
      }).join("") : '<div class="empty">暂无待审核提炼</div>';
      for (const button of $("reviewCandidates").querySelectorAll("button[data-review-action]")) {
        button.onclick = () => handleReviewAction(button.dataset.reviewAction, button.dataset.reviewId).catch(showError);
      }
    }

    async function loadReviewCandidates() {
      const result = await api("/api/v1/panel/review/candidates?limit=100");
      renderReviewCandidates(result);
    }

    async function handleReviewAction(action, id) {
      const candidate = state.reviewCandidates.find((item) => item.id === id);
      if (!candidate) return;
      if (action === "reject") {
        const reason = prompt("拒绝原因（可选）") ?? "";
        await api("/api/v1/panel/review/candidates/" + encodeURIComponent(id) + "/reject", { method: "POST", body: JSON.stringify({ requestId: "panel-" + Date.now(), adapterId: "memory-console", reason }) });
        showToast("候选已拒绝");
      } else {
        let title;
        let content;
        if (action === "edit") {
          title = prompt("修改标题", candidate.title || "");
          if (title === null) return;
          content = prompt("修改结论", candidate.conclusion || "");
          if (content === null || !content.trim()) return;
        }
        await api("/api/v1/panel/review/candidates/" + encodeURIComponent(id) + "/approve", { method: "POST", body: JSON.stringify({ requestId: "panel-" + Date.now(), adapterId: "memory-console", ...(title !== undefined ? { title, content } : {}) }) });
        showToast(action === "edit" ? "已修改并批准" : "候选已批准");
      }
      await Promise.all([loadDashboard(), loadReviewCandidates(), loadMemories()]);
    }

    async function bulkApproveCandidates() {
      const button = $("bulkApproveCandidates");
      button.disabled = true;
      try {
        const result = await api("/api/v1/panel/review/candidates/bulk-approve", { method: "POST", body: JSON.stringify({ requestId: "panel-" + Date.now(), adapterId: "memory-console", minimumConfidence: 0.8 }) });
        showToast("已批准 " + formatNumber(result.approved) + " 条高置信度候选");
        await Promise.all([loadDashboard(), loadReviewCandidates(), loadMemories()]);
      } finally { button.disabled = false; }
    }

    function renderRecentActivity(activity) {
      const entries = (activity.entries || []).slice(0, 6);
      $("recentActivity").innerHTML = entries.length ? entries.map((entry) =>
        '<div class="system-row"><div><strong>' + esc(entry.action) + '</strong><div class="muted mono" style="margin-top:3px">' + esc(entry.targetId || entry.id) + '</div></div><span>' + esc(formatDate(entry.at)) + '</span></div>'
      ).join("") : '<div class="empty">暂无变化</div>';
    }

    async function loadDashboard() {
      const [overview, analysis, metrics, status, activity, evolution, contextPack, namespaceAudit, reviewCandidates] = await Promise.all([
        api("/api/v1/panel/overview"), api("/api/v1/panel/analysis"), api("/api/v1/panel/metrics"), api("/api/v1/panel/status"), api("/api/v1/panel/activity?limit=20"),
        api("/api/v1/panel/evolution"), api("/api/v1/panel/context-packs"), api("/api/v1/panel/namespace-audit"), api("/api/v1/panel/review/candidates?limit=100")
      ]);
      state.overview = overview; state.analysis = analysis; state.metrics = metrics; state.status = status; state.serviceActivity = activity; state.evolution = evolution; state.contextPack = contextPack; state.namespaceAudit = namespaceAudit;
      renderStats(overview); renderAnalysis(analysis); renderActivityChart(overview); renderSources(overview); renderNamespaces(overview); renderQueues(metrics); renderRecentActivity(activity); renderEvolution(evolution); renderContextPack(contextPack); renderNamespaceAudit(namespaceAudit); renderReviewCandidates(reviewCandidates); renderConnectionStatus(status);
    }

    function paramsForList() {
      const params = new URLSearchParams();
      params.set("page", String(state.page));
      const q = $("query").value.trim();
      if (q) params.set("q", q);
      if ($("layer").value) params.set("layer", $("layer").value);
      if ($("status").value) params.set("status", $("status").value);
      if ($("sourceAgent").value) params.set("sourceAgent", $("sourceAgent").value);
      if ($("projectScope").value) {
        const parts = $("projectScope").value.split(":");
        if (parts[0] === "workspace") params.set("workspaceId", parts.slice(1).join(":"));
        if (parts[0] === "project") params.set("projectId", parts.slice(1).join(":"));
      }
      return params;
    }

    function renderRows(items) {
      $("emptyState").classList.toggle("hidden", items.length > 0);
      $("memoryRows").innerHTML = items.map((item) => {
        const source = valueAt(item, ["metadata", "source"], "unknown");
        const namespace = valueAt(item, ["metadata", "namespace"], undefined);
        return '<tr data-id="' + esc(item.id) + '" tabindex="0" class="' + (item.id === state.selectedMemoryId ? "selected" : "") + '">' +
          '<td><span class="pill layer-' + esc(item.memoryLayer) + '">' + esc(item.memoryLayer) + '</span></td>' +
          '<td><div class="memory-title">' + esc(displayMemoryTitle(item.title, item.id)) + '</div><div class="memory-summary">' + esc(item.summary || "") + '</div><div class="memory-id"><span class="mono">' + esc(item.id) + '</span> · ' + esc(source) + ' · ' + esc(namespaceLabel(namespace)) + '</div></td>' +
          '<td><span class="status-' + esc(item.status) + '">' + esc(item.status) + '</span></td>' +
          '<td>' + esc(formatDate(item.updatedAt || item.createdAt)) + '<div class="muted mono" style="margin-top:4px">v' + esc(item.version || 1) + '</div></td></tr>';
      }).join("");
      for (const row of $("memoryRows").querySelectorAll("tr")) {
        row.onclick = () => loadMemoryDetail(row.dataset.id);
        row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); loadMemoryDetail(row.dataset.id); } };
      }
    }

    function renderListMeta(data) {
      const shown = Array.isArray(data.items) ? data.items.length : 0;
      $("listMeta").textContent = formatNumber(data.total) + " matched · " + state.lastRequestMs + " ms";
      $("memoryResultSummary").textContent = formatNumber(shown) + " shown";
      $("pageInput").value = String(state.page);
      $("totalPagesText").textContent = String(state.totalPages);
      $("prevPage").disabled = !data.hasPrev;
      $("nextPage").disabled = !data.hasNext;
    }

    async function loadMemories() {
      const data = await api("/api/v1/panel/items?" + paramsForList().toString());
      state.page = data.page || state.page; state.pageSize = data.pageSize || state.pageSize; state.total = data.total || 0; state.totalPages = data.totalPages || 1;
      renderRows(data.items || []); renderListMeta(data);
      if (!state.selectedMemoryId && !$("detailContent").textContent.trim()) $("detailContent").textContent = "从左侧选择记忆";
    }

    function renderMemoryDetail(data, requestedMemoryId) {
      const item = data.item || {};
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const source = valueAt(item, ["metadata", "source"], valueAt(item, ["info", "source"], "unknown"));
      const namespace = valueAt(item, ["metadata", "namespace"], undefined);
      const summary = item.summary || item.content || valueAt(item, ["properties", "summary"], "");
      $("detailTitle").textContent = displayMemoryTitle(item.title, requestedMemoryId);
      $("detailId").textContent = requestedMemoryId;
      $("detailContent").innerHTML =
        '<section class="detail-section"><h3>内容</h3><div class="detail-summary">' + esc(summary || "无摘要") + '</div></section>' +
        '<section class="detail-section"><h3>属性</h3><div class="detail-grid">' +
          '<div class="detail-field"><span>Memory Layer</span><strong>' + esc(item.memoryLayer || item.layer || "-") + '</strong></div>' +
          '<div class="detail-field"><span>Status</span><strong>' + esc(item.status || "-") + '</strong></div>' +
          '<div class="detail-field"><span>Source</span><strong>' + esc(source) + '</strong></div>' +
          '<div class="detail-field"><span>Project</span><strong>' + esc(namespaceLabel(namespace)) + '</strong></div>' +
          '<div class="detail-field"><span>Workspace</span><strong>' + esc(namespace && (namespace.workspacePath || namespace.workspaceId) || "-") + '</strong></div>' +
          '<div class="detail-field"><span>Updated</span><strong>' + esc(formatDate(item.updatedAt || item.createdAt, true)) + '</strong></div>' +
        '</div></section>' +
        '<section class="detail-section"><h3>Tags</h3><div class="tag-list">' + (tags.length ? tags.map((tag) => '<span class="pill">' + esc(tag) + '</span>').join("") : '<span class="muted">无</span>') + '</div></section>' +
        '<section class="detail-section"><h3>Raw JSON</h3><pre>' + esc(jsonText(data)) + '</pre></section>';
      $("detailJson").textContent = jsonText(data);
      $("deleteMemory").disabled = false;
      $("markUseful").disabled = false; $("markNotUseful").disabled = false; $("mergeMemory").disabled = false; $("archiveMemory").disabled = false;
      $("promoteMemory").disabled = (item.memoryLayer || item.layer) !== "L1";
    }

    async function loadMemoryDetail(id) {
      if (!id) return;
      const requestedMemoryId = id;
      state.selectedMemoryId = requestedMemoryId;
      clearError();
      for (const row of $("memoryRows").querySelectorAll("tr")) row.classList.toggle("selected", row.dataset.id === requestedMemoryId);
      $("detailTitle").textContent = "正在加载"; $("detailId").textContent = requestedMemoryId; $("detailContent").innerHTML = '<div class="empty">正在加载记忆</div>';
      try {
        const data = await api("/api/v1/memory/" + encodeURIComponent(requestedMemoryId));
        if (state.selectedMemoryId !== requestedMemoryId) return;
        state.detailJson = data; renderMemoryDetail(data, requestedMemoryId);
      } catch (error) {
        if (state.selectedMemoryId !== requestedMemoryId) return;
        state.detailJson = { error: error.message || String(error), id: requestedMemoryId };
        $("detailTitle").textContent = "加载失败"; $("detailJson").textContent = jsonText(state.detailJson); $("detailContent").innerHTML = '<div class="empty error">' + esc(state.detailJson.error) + '</div>'; showError(error);
      }
    }

    async function removeSelectedMemory() {
      const id = state.selectedMemoryId;
      if (!id || !confirm("删除这条记忆？")) return;
      await api("/api/v1/memory/" + encodeURIComponent(id), { method: "DELETE", body: requestBody("memory_console_delete") });
      state.selectedMemoryId = undefined; state.detailJson = {}; $("deleteMemory").disabled = true; $("detailTitle").textContent = "选择一条记忆"; $("detailId").textContent = ""; $("detailContent").innerHTML = '<div class="empty">记忆已删除</div>'; showToast("记忆已删除");
      await Promise.all([loadMemories(), loadDashboard()]);
    }

    async function memoryAction(action, body = {}) {
      const id = state.selectedMemoryId; if (!id) return;
      const result = await api("/api/v1/memory/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: JSON.stringify({ requestId: "panel-" + Date.now(), adapterId: "memory-console", ...body }) });
      showToast(action === "quality" ? "质量标记已保存" : action === "promote" ? "已提升为 L2" : action === "archive" ? "记忆已归档" : "记忆已合并");
      await Promise.all([loadMemories(), loadDashboard()]);
      return result;
    }
    async function mergeSelectedMemory() {
      const sourceMemoryId = prompt("输入要合并进当前记忆的重复 Memory ID");
      if (!sourceMemoryId) return;
      await memoryAction("merge", { sourceMemoryId, reason: "duplicate memory merged in console" });
    }

    function activityParams() {
      const params = new URLSearchParams(); params.set("limit", "100");
      if ($("activityTool").value) params.set("tools", $("activityTool").value);
      if ($("activitySource").value) params.set("sourceAgent", $("activitySource").value);
      return params;
    }

    function activityMatchesQuery(log, query) { return !query || jsonText(log).toLowerCase().includes(query.toLowerCase()); }
    function renderActivityRows(logs) {
      const query = $("activityQuery").value.trim();
      const filtered = logs.filter((log) => activityMatchesQuery(log, query));
      $("activityEmpty").classList.toggle("hidden", filtered.length > 0);
      $("activityMeta").textContent = formatNumber(filtered.length) + " / " + formatNumber(logs.length);
      $("activityRows").innerHTML = filtered.map((log, index) => {
        const id = log.id || String(index);
        const source = log.sourceAgent || log.source || log.adapterId || "unknown";
        const result = log.success === false || log.error ? "failed" : "ok";
        return '<tr data-id="' + esc(id) + '" tabindex="0" class="' + (id === state.selectedActivityId ? "selected" : "") + '"><td>' + esc(formatDate(log.calledAt || log.createdAt, true)) + '</td><td><span class="pill">' + esc(log.toolName || log.action || "event") + '</span></td><td><strong>' + esc(source) + '</strong><div class="muted status-' + result + '" style="margin-top:3px">' + esc(result) + '</div></td><td class="mono">' + esc(formatNumber(log.durationMs)) + ' ms</td></tr>';
      }).join("");
      for (const row of $("activityRows").querySelectorAll("tr")) {
        row.onclick = () => selectActivity(row.dataset.id);
        row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectActivity(row.dataset.id); } };
      }
    }

    async function loadApiActivity() {
      const data = await api("/api/v1/memory/logs?" + activityParams().toString());
      state.activityLogs = data.logs || [];
      renderActivityRows(state.activityLogs);
    }
    function selectActivity(id) {
      const log = state.activityLogs.find((entry, index) => String(entry.id || index) === String(id));
      if (!log) return;
      state.selectedActivityId = id; state.activityJson = log;
      for (const row of $("activityRows").querySelectorAll("tr")) row.classList.toggle("selected", row.dataset.id === String(id));
      $("activityDetailTitle").textContent = log.toolName || log.action || "Activity"; $("activityDetailId").textContent = id; $("activityDetailJson").textContent = jsonText(log);
    }

    function taskTitle(task) { return valueAt(task, ["episode", "title"], valueAt(task, ["episode", "summary"], valueAt(task, ["episode", "goal"], task.id))); }
    function renderTasks(data) {
      state.tasks = data.tasks || []; state.taskPage = data.page || 1; state.taskTotalPages = data.totalPages || 1;
      $("taskEmpty").classList.toggle("hidden", state.tasks.length > 0);
      $("taskMeta").textContent = formatNumber(data.total) + " episodes"; $("taskResultSummary").textContent = formatNumber(state.tasks.length) + " shown"; $("taskPageText").textContent = state.taskPage + " / " + state.taskTotalPages; $("prevTaskPage").disabled = !data.hasPrev; $("nextTaskPage").disabled = !data.hasNext;
      $("taskRows").innerHTML = state.tasks.map((task) => '<button class="task-item ' + (task.id === state.selectedTaskId ? "selected" : "") + '" data-id="' + esc(task.id) + '"><strong>' + esc(taskTitle(task)) + '</strong><div class="task-meta"><span>' + esc(formatNumber((task.turns || []).length)) + ' turns · ' + esc(formatNumber((task.memoryIds || []).length)) + ' memories</span><span>' + esc(formatDate(task.updatedAt)) + '</span></div></button>').join("");
      for (const row of $("taskRows").querySelectorAll("button")) row.onclick = () => selectTask(row.dataset.id);
    }

    async function loadTokenStats() {
      const data = await api("/api/v1/agent-token-stats");
      state.tokenStats = data;
      renderTokenStatsProjectOptions();
      $("tokenStatsProject").onchange = () => renderTokenStats();
      $("tokenStatsScannedAt").textContent = "扫描时间: " + new Date(data.scannedAt).toLocaleString() + " · 数据缓存 5 分钟";
    }

    function renderTokenStatsProjectOptions() {
      const select = $("tokenStatsProject");
      const previousProject = select.value ? select.options?.[select.selectedIndex]?.text : "";
      const projects = state.tokenStats.projects || [];
      select.innerHTML = projects.map((project, index) => '<option value="' + index + '">' + esc(project.project) + '</option>').join("");
      const previousIndex = projects.findIndex((project) => project.project === previousProject);
      select.value = String(previousIndex >= 0 ? previousIndex : 0);
      renderTokenStats();
    }

    function agentTokenValue(project, agentName) {
      const agent = (project?.agents || []).find((item) => item.agent === agentName);
      return agent ? Number(agent.totalTokens || 0) : 0;
    }

    function renderTokenStats() {
      const projects = state.tokenStats.projects || [];
      const project = projects[Number($("tokenStatsProject").value) || 0];
      const labels = { pi: "Pi", codex: "Codex", claude_code: "Claude Code" };
      $("tokenStatsLegend").innerHTML = Object.entries(labels).map(([key, label]) => '<span class="pill"><span class="token-chart-bar ' + key + '" style="display:inline-block;width:10px;height:10px;min-height:0;margin-right:5px"></span>' + label + '</span>').join("");
      if (!project) {
        $("tokenStatsChart").innerHTML = '<div class="token-chart-empty">未找到 Token 用量数据</div>';
        $("tokenStatsCombined").innerHTML = "";
        return;
      }

      const monthly = (state.tokenStats.monthly || []).map((entry) => ({
        month: entry.month,
        project: (entry.projects || []).find((item) => item.project === project.project)
      })).filter((entry) => entry.project);
      const values = monthly.flatMap((entry) => ["pi", "codex", "claude_code"].map((agent) => agentTokenValue(entry.project, agent)));
      const maxValue = Math.max(...values, 1);
      $("tokenStatsChart").innerHTML = monthly.length ? monthly.map((entry) => {
        const bars = ["pi", "codex", "claude_code"].map((agent) => {
          const value = agentTokenValue(entry.project, agent);
          const height = value > 0 ? Math.max(3, Math.round(value / maxValue * 210)) : 2;
          return '<div class="token-chart-bar ' + agent + '" style="height:' + height + 'px" title="' + esc(labels[agent] + ': ' + formatTokenCount(value) + ' Token (' + formatNumber(value) + ')') + '"></div>';
        }).join("");
        const monthTotal = Number(entry.project.combinedTotalTokens || 0);
        return '<div class="token-chart-month"><div class="token-chart-value" title="' + formatNumber(monthTotal) + '">' + formatTokenCount(monthTotal) + '</div><div class="token-chart-bars">' + bars + '</div><div class="token-chart-label">' + esc(entry.month) + '</div></div>';
      }).join("") : '<div class="token-chart-empty">该项目暂无月度数据</div>';

      $("tokenStatsCombined").innerHTML = '<div class="queue-item" title="' + formatNumber(project.combinedInputTokens) + '"><strong>' + formatTokenCount(project.combinedInputTokens) + '</strong><span>输入 Token</span></div>'
        + '<div class="queue-item" title="' + formatNumber(project.combinedOutputTokens) + '"><strong>' + formatTokenCount(project.combinedOutputTokens) + '</strong><span>输出 Token</span></div>'
        + '<div class="queue-item" title="' + formatNumber(project.combinedCacheReadTokens) + '"><strong>' + formatTokenCount(project.combinedCacheReadTokens) + '</strong><span>缓存读取</span></div>'
        + '<div class="queue-item" title="' + formatNumber(project.combinedTotalTokens) + '"><strong style="color:var(--accent)">' + formatTokenCount(project.combinedTotalTokens) + '</strong><span>总 Token</span></div>'
        + (project.estimatedCost ? '<div class="queue-item"><strong>$' + project.estimatedCost.toFixed(4) + '</strong><span>预估费用</span></div>' : '');
    }
    async function loadTasks() {
      const params = new URLSearchParams({ page: String(state.taskPage) }); const q = $("taskQuery").value.trim(); if (q) params.set("q", q);
      renderTasks(await api("/api/v1/panel/tasks?" + params.toString()));
    }
    function selectTask(id) {
      const task = state.tasks.find((item) => item.id === id); if (!task) return;
      state.selectedTaskId = id; state.taskJson = task;
      for (const row of $("taskRows").querySelectorAll("button")) row.classList.toggle("selected", row.dataset.id === id);
      $("taskDetailTitle").textContent = taskTitle(task); $("taskDetailId").textContent = id; $("deleteTask").disabled = false;
      $("taskDetailContent").innerHTML = '<section class="detail-section"><h3>统计</h3><div class="detail-grid"><div class="detail-field"><span>Turns</span><strong>' + esc(formatNumber((task.turns || []).length)) + '</strong></div><div class="detail-field"><span>Memories</span><strong>' + esc(formatNumber((task.memoryIds || []).length)) + '</strong></div></div></section><section class="detail-section"><h3>关联 Memory IDs</h3><div class="tag-list">' + ((task.memoryIds || []).map((memoryId) => '<span class="pill mono">' + esc(memoryId) + '</span>').join("") || '<span class="muted">无</span>') + '</div></section><section class="detail-section"><h3>Raw JSON</h3><pre>' + esc(jsonText(task)) + '</pre></section>';
      $("taskDetailJson").textContent = jsonText(task);
    }
    async function removeSelectedTask() {
      const id = state.selectedTaskId; if (!id || !confirm("删除这个任务记录？关联 Memories 不会被删除。")) return;
      await api("/api/v1/panel/tasks/" + encodeURIComponent(id), { method: "DELETE", body: requestBody("memory_console_task_delete") });
      state.selectedTaskId = undefined; state.taskJson = {}; $("deleteTask").disabled = true; $("taskDetailTitle").textContent = "选择一个任务"; $("taskDetailId").textContent = ""; $("taskDetailContent").innerHTML = '<div class="empty">任务已删除</div>'; showToast("任务已删除"); await loadTasks();
    }

    function row(label, value, valueClass = "") { return '<div class="system-row"><span>' + esc(label) + '</span><strong class="' + esc(valueClass) + '">' + esc(value) + '</strong></div>'; }
    function renderConnectionStatus(status) {
      const health = status.health || {};
      const online = health.ok === true;
      $("sidebarStatusDot").classList.toggle("online", online); $("sidebarStatusText").textContent = online ? "服务正常" : "服务异常"; $("sidebarVersion").textContent = health.version ? "v" + health.version : "";
    }
    function renderSystem(status, metrics, config) {
      const health = status.health || {}; const storage = health.storage || metrics.storage || {}; const schema = metrics.schema || {}; const jobs = metrics.jobs || {}; const retries = metrics.embeddingRetries || {};
      $("systemHealthBadge").textContent = health.ok ? "healthy" : "unhealthy"; $("systemHealthBadge").className = "pill status-" + (health.ok ? "ok" : "failed");
      $("systemHealth").innerHTML = row("Version", health.version || "-") + row("Mode", health.mode || "-") + row("Profile", health.activeProfile || "-") + row("Uptime", formatNumber(Math.round(Number(health.uptimeMs || 0) / 1000)) + " s") + row("Server time", formatDate(status.serverTime, true));
      $("systemSchema").textContent = schema.version !== undefined ? "schema v" + schema.version : "";
      $("systemStorage").innerHTML = row("Backend", storage.backend || "-") + row("Vector", storage.vectorBackend || storage.vector || "-") + row("Change sequence", formatNumber(metrics.changeSeq)) + row("Recent feedback", formatNumber(valueAt(metrics, ["feedback", "recent"], 0)));
      const models = metrics.models && typeof metrics.models === "object" ? Object.entries(metrics.models) : [];
      $("systemModels").innerHTML = models.length ? models.map(([name, model]) => '<div class="model-item"><div><strong>' + esc(name) + '</strong><div class="muted" style="margin-top:3px">' + esc(typeof model === "object" ? model.model || model.provider || "configured" : model) + '</div></div><span class="pill">' + esc(typeof model === "object" ? model.status || (model.enabled === false ? "disabled" : "ready") : "ready") + '</span></div>').join("") : '<div class="empty">未报告模型状态</div>';
      $("systemQueues").innerHTML = [[jobs.queued, "Jobs queued"], [jobs.leased, "Jobs leased"], [Number(jobs.failed || 0) + Number(jobs.dead_letter || 0), "Jobs failed"], [retries.pending, "Embedding pending"], [retries.in_progress, "Embedding active"], [retries.failed, "Embedding failed"]].map((item) => '<div class="queue-item"><strong>' + esc(formatNumber(item[0])) + '</strong><span>' + esc(item[1]) + '</span></div>').join("");
      $("configJson").textContent = jsonText(config);
      renderConnectionStatus(status);
    }
    async function loadSystem() {
      const [status, metrics, config] = await Promise.all([api("/api/v1/panel/status"), api("/api/v1/panel/metrics"), api("/api/v1/panel/config")]);
      state.status = status; state.metrics = metrics; state.config = config; renderSystem(status, metrics, config);
    }

    function generatedSummary(result) { const generated = result.generated || {}; return "L2 +" + formatNumber(generated.L2) + " · L3 +" + formatNumber(generated.L3) + " · Skill +" + formatNumber(generated.Skill); }
    async function workerAction(buttonId, path) { $(buttonId).disabled = true; try { const result = await api(path, { method: "POST", body: JSON.stringify({ limit: 100, adapterId: "memory-console" }) }); showToast(generatedSummary(result)); await Promise.all([loadSystem(), loadDashboard(), loadMemories()]); } finally { $(buttonId).disabled = false; } }
    async function runWorker() { return workerAction("runWorker", "/api/v1/worker/run"); }
    async function reloadConfig() { $("reloadConfig").disabled = true; try { await api("/api/v1/admin/reload-config", { method: "POST", body: JSON.stringify({ reason: "memory_console", adapterId: "memory-console" }) }); showToast("配置已重新加载"); await Promise.all([loadDashboard(), loadSystem()]); } finally { $("reloadConfig").disabled = false; } }

    async function refreshCurrentView() {
      if (!memoryToken) { showAuth(); return; }
      clearError();
      try {
        if (state.view === "dashboard") await loadDashboard();
        else if (state.view === "memories") await loadMemories();
        else if (state.view === "activity") await loadApiActivity();
        else if (state.view === "tasks") await loadTasks();
        else if (state.view === "tokenStats") await loadTokenStats();
        else if (state.view === "audit") await loadDashboard();
        else if (state.view === "system") await loadSystem();
      } catch (error) { showError(error); }
    }
    async function refreshAll() {
      if (!memoryToken) { showAuth(); return; }
      clearError();
      try { await Promise.all([loadDashboard(), loadMemories()]); } catch (error) { showError(error); }
    }
    async function applyFilters() { state.page = 1; state.selectedMemoryId = undefined; await loadMemories(); }
    async function goToPage() { const nextPage = Number($("pageInput").value); if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > state.totalPages) { $("pageInput").value = String(state.page); return; } state.page = nextPage; state.selectedMemoryId = undefined; await loadMemories(); }
    function applyTheme(theme) { document.documentElement.classList.toggle("dark", theme === "dark"); if (typeof localStorage !== "undefined") localStorage.setItem("memmyMemoryTheme", theme); }
    function initTheme() { const stored = typeof localStorage !== "undefined" ? localStorage.getItem("memmyMemoryTheme") : ""; const preferred = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; applyTheme(stored || preferred); }

    $("navDashboard").onclick = () => setView("dashboard"); $("navMemories").onclick = () => setView("memories"); $("navActivity").onclick = () => setView("activity"); $("navTasks").onclick = () => setView("tasks"); $("navTokenStats").onclick = () => setView("tokenStats"); $("navAudit").onclick = () => setView("audit"); $("navSystem").onclick = () => setView("system");
    $("refresh").onclick = refreshCurrentView; $("openActivity").onclick = () => setView("activity");
    $("search").onclick = applyFilters; $("clearFilters").onclick = () => { $("query").value = ""; $("layer").value = ""; $("status").value = ""; $("sourceAgent").value = ""; $("projectScope").value = ""; $("contextPackScope").value = ""; renderContextPack(state.contextPack || {}); applyFilters(); };
    $("prevPage").onclick = () => { if (state.page > 1) { state.page -= 1; loadMemories(); } }; $("nextPage").onclick = () => { if (state.page < state.totalPages) { state.page += 1; loadMemories(); } };
    $("pageInput").onkeydown = (event) => { if (event.key === "Enter") goToPage(); }; $("pageInput").onfocus = () => $("pageInput").select(); $("pageInput").onchange = goToPage;
    $("query").onkeydown = (event) => { if (event.key === "Enter") applyFilters(); }; $("layer").onchange = applyFilters; $("status").onchange = applyFilters; $("sourceAgent").onchange = applyFilters; $("projectScope").onchange = applyFilters;
    $("contextPackScope").onchange = () => renderContextPack(state.contextPack || {});
    $("contextPackOutlineTab").onclick = () => setContextPackView("outline"); $("contextPackGraphTab").onclick = () => setContextPackView("graph"); $("contextPackMarkdownTab").onclick = () => setContextPackView("markdown");
    $("closeContextMemoryDialog").onclick = closeContextDialog; $("editContextMemory").onclick = beginContextMemoryEdit; $("cancelContextMemoryEdit").onclick = cancelContextMemoryEdit; $("contextMemoryEditForm").onsubmit = (event) => saveContextMemory(event).catch(showError);
    $("copyJson").onclick = () => copyJson(state.detailJson); $("deleteMemory").onclick = () => removeSelectedMemory().catch(showError);
    $("markUseful").onclick = () => memoryAction("quality", { useful: true }).catch(showError); $("markNotUseful").onclick = () => memoryAction("quality", { useful: false }).catch(showError); $("archiveMemory").onclick = () => memoryAction("archive", { reason: "noise archived in console" }).catch(showError); $("promoteMemory").onclick = () => memoryAction("promote", { reason: "manual L1 promotion" }).catch(showError); $("mergeMemory").onclick = () => mergeSelectedMemory().catch(showError);
    $("loadActivity").onclick = () => loadApiActivity().catch(showError); $("clearActivity").onclick = () => { $("activityQuery").value = ""; $("activityTool").value = ""; $("activitySource").value = ""; loadApiActivity().catch(showError); }; $("activityQuery").onkeydown = (event) => { if (event.key === "Enter") renderActivityRows(state.activityLogs); }; $("activityTool").onchange = () => loadApiActivity().catch(showError); $("activitySource").onchange = () => loadApiActivity().catch(showError); $("copyActivity").onclick = () => copyJson(state.activityJson);
    $("searchTasks").onclick = () => { state.taskPage = 1; loadTasks().catch(showError); }; $("clearTasks").onclick = () => { $("taskQuery").value = ""; state.taskPage = 1; loadTasks().catch(showError); }; $("taskQuery").onkeydown = (event) => { if (event.key === "Enter") { state.taskPage = 1; loadTasks().catch(showError); } }; $("prevTaskPage").onclick = () => { if (state.taskPage > 1) { state.taskPage -= 1; loadTasks().catch(showError); } }; $("nextTaskPage").onclick = () => { if (state.taskPage < state.taskTotalPages) { state.taskPage += 1; loadTasks().catch(showError); } }; $("copyTask").onclick = () => copyJson(state.taskJson); $("deleteTask").onclick = () => removeSelectedTask().catch(showError);
    $("runWorker").onclick = () => runWorker().catch(showError); $("retryFailed").onclick = () => workerAction("retryFailed", "/api/v1/worker/retry-failed").catch(showError); $("promoteCandidates").onclick = () => workerAction("promoteCandidates", "/api/v1/worker/promote-candidates").catch(showError); $("reloadConfig").onclick = () => reloadConfig().catch(showError); $("copyConfig").onclick = () => copyJson(state.config); $("copyContextPack").onclick = () => navigator.clipboard.writeText(contextPackMarkdown(state.contextPack || {}, $("contextPackScope").value)).then(() => showToast("上下文包已复制")); $("exportContextPack").onclick = exportContextPackMarkdown; $("copyAuditPacks").onclick = () => navigator.clipboard.writeText(contextPackMarkdown(state.contextPack || {})).then(() => showToast("上下文包已复制")); $("bulkApproveCandidates").onclick = () => bulkApproveCandidates().catch(showError);
    $("themeToggle").onclick = () => applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
    $("lockConsole").onclick = () => { memoryToken = ""; if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("memmyMemoryToken"); showAuth(); };
    $("connectToken").onclick = async () => { const token = $("tokenInput").value.trim(); if (!token) { showAuth("请输入访问令牌"); return; } memoryToken = token; if (typeof sessionStorage !== "undefined") sessionStorage.setItem("memmyMemoryToken", token); try { await api("/api/v1/panel/status"); hideAuth(); $("tokenInput").value = ""; await refreshAll(); } catch (error) { showAuth(error.message || String(error)); } };
    $("tokenInput").onkeydown = (event) => { if (event.key === "Enter") $("connectToken").onclick(); };

    initTheme();
    if (memoryToken) refreshAll(); else showAuth();
  </script>
</body>
</html>`;
}
