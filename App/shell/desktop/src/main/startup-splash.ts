import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type StartupSplashLanguage = "zh-CN" | "en-US";

export function resolveStartupSplashLanguage(
  databasePath: string,
  fallback: StartupSplashLanguage
): StartupSplashLanguage {
  if (!existsSync(databasePath)) {
    return fallback;
  }

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database
      .prepare("SELECT language FROM app_settings WHERE id = 'default'")
      .get() as { language?: unknown } | undefined;
    return row?.language === "zh-CN" || row?.language === "en-US" ? row.language : fallback;
  } catch {
    return fallback;
  } finally {
    database?.close();
  }
}

export function resolveStartupSplashHtml(language: StartupSplashLanguage): string {
  const hint = language === "en-US" ? "Starting…" : "正在启动…";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font-family:-apple-system,"Segoe UI",sans-serif;}
body{display:flex;align-items:center;justify-content:center;background:#1f2937;color:#f9fafb;-webkit-user-select:none;cursor:default;}
.box{display:flex;flex-direction:column;align-items:center;gap:16px;}
.title{font-size:22px;font-weight:600;letter-spacing:1px;}
.hint{font-size:13px;color:#9ca3af;}
.spinner{width:28px;height:28px;border:3px solid rgba(255,255,255,.2);border-top-color:#34d399;border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
</style></head><body><div class="box"><div class="spinner"></div><div class="title">Memmy</div><div class="hint">${hint}</div></div></body></html>`;
}
