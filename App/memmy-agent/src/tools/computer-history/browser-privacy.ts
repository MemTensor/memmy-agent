// Browser capture requires positive, window-bound evidence from browser chrome.
// A flat accessibility tree cannot distinguish page controls from chrome. It is
// useful for an extra private-window veto, never for authorizing a capture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRIVATE_TITLE_MARKERS: readonly string[] = [
  "incognito", "inprivate", "private browsing", "(private)", "[inprivate]",
  "[incognito]", "[guest]", "[private]",
  "无痕", "隐身", "隐私浏览", "私密浏览", "［无痕］", "（无痕）", "[访客]", "［访客］",
  "無痕", "隱私瀏覽", "私密瀏覽", "[訪客]",
  "シークレット", "プライベート", "[ゲスト]", "시크릿", "인코그니토", "[게스트]",
  "navegación privada", "navegação privada", "navigation privée",
  "navigazione privata", "privates fenster", "inkognito", "incógnito",
  "navegación de incógnito", "navigation privata", "privát", "privātā",
  "privatus", "privát böngészés", "anoniem", "privé-navigatie",
  "prywat", "privatno", "gizli", "súkrom", "инкогнито", "приват", "приватн",
  "частный", "частное", "режим инкогнито",
];

export const PRIVATE_CONTROL_MARKERS: readonly string[] = [
  "incognito", "inprivate", "private browsing",
  "无痕模式", "无痕浏览", "无痕式", "隐身模式", "無痕模式", "無痕瀏覽",
  "シークレット モード", "시크릿 모드", "来宾个人资料", "来賓個人資料",
];
const EXACT_GUEST_CONTROL_NAMES = new Set([
  "guest", "guest profile", "guest mode", "访客", "访客模式", "訪客", "訪客模式",
  "来宾", "來賓", "ゲスト", "게스트",
]);
const ADDRESS_CONTROL_LABELS: readonly string[] = [
  "address and search bar", "address bar", "search or enter address",
  "search or type url", "omnibox", "地址和搜索栏", "地址栏", "網址和搜尋列", "地址與搜尋列",
];

export interface NativeBrowserContext {
  url: string;
  mode: "normal" | "private" | "unknown";
  /** False when chrome enumeration failed, exceeded a limit, or was truncated. */
  complete: boolean;
  windowId: string;
  processId: number;
}

/** Observed independently of Computer Use claims, which may remain connected in the background. */
export interface BrowserFocusObservation {
  connectionId: string;
  browser: "chrome" | "edge";
  focused: boolean;
  tabId: number | null;
  /** Browser windows API id; never confuse this with a native HWND. */
  windowId: number | null;
  title: string;
  url: string;
  mode: "normal" | "private" | "unknown";
  /** Time of the real extension API observation, not a snapshot-file refresh. */
  observedAt: number;
  receivedAt: number;
}

export interface BrowserAuthoritySnapshot {
  version?: 2;
  updatedAt: number;
  browsers: Record<string, {
    connected: boolean;
    /** Legacy field is kept empty; a URL alone is never authorization. */
    activeUrl?: null | string;
    focusedTab?: BrowserFocusObservation | null;
  }>;
}

export interface BrowserContextInput {
  browserName: string;
  title: string;
  axText: string;
  nativeContext?: NativeBrowserContext | null;
  windowId?: string;
  processId?: number;
  authority?: BrowserAuthoritySnapshot | null;
  now?: number;
}

export interface BrowserContextResult {
  url: string;
  private: boolean | null;
  source: "extension" | "extension_no_tab" | "title_marker" | "control_marker" | "tree"
    | "native_context" | "unknown" | "extension_mismatch";
}

export function bridgeBrowserId(browserName: string): "chrome" | "edge" | null {
  const name = browserName.toLowerCase().replace(/^win32\./u, "").replace(/\.exe$/u, "");
  if (name === "chrome" || name === "google chrome") return "chrome";
  if (name === "msedge" || name === "edge" || name === "microsoft edge") return "edge";
  return null;
}

export function isPrivateBrowsingTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return PRIVATE_TITLE_MARKERS.some((marker) => lower.includes(marker));
}

function treeRows(axText: string): Array<{ role: string; name: string; value: string }> {
  if (!axText) return [];
  return axText.split("\n").map((line) => {
    const parts = (/^[+-] /u.test(line) ? line.slice(2) : line).split("|");
    return { role: parts[0] ?? "", name: parts[2] ?? "", value: parts[5] ?? "" };
  });
}

/** Safe-direction veto only: page buttons may cause an extra exclusion, never permit capture. */
export function treeHasPrivateControl(axText: string): boolean {
  return treeRows(axText).some(({ role, name }) => {
    if (!/button/iu.test(role)) return false;
    const lower = name.trim().toLowerCase();
    return EXACT_GUEST_CONTROL_NAMES.has(lower)
      || PRIVATE_CONTROL_MARKERS.some((marker) => lower.includes(marker));
  });
}

export function sanitizeBrowserUrl(raw: string): string {
  if (!raw) return "";
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/iu.test(value)) value = `https://${value}`;
    else return "";
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return `${url.origin}${url.pathname}`;
  } catch { return ""; }
}

/** Diagnostic helper only. Without native ancestry, even a labelled row is not proof of chrome. */
export function addressBarUrlFromTree(axText: string): string {
  for (const { role, name, value } of treeRows(axText)) {
    if (!/edit|combobox|textfield/iu.test(role)
      || !ADDRESS_CONTROL_LABELS.some((label) => name.toLowerCase() === label)) continue;
    const url = sanitizeBrowserUrl(value);
    if (url) return url;
  }
  return "";
}

export const BROWSER_AUTHORITY_MAX_AGE_MS = 5_000;
const MAX_CLOCK_SKEW_MS = 1_000;

function freshTimestamp(value: number, now: number): boolean {
  return Number.isFinite(value) && value > 0
    && value <= now + MAX_CLOCK_SKEW_MS && now - value <= BROWSER_AUTHORITY_MAX_AGE_MS;
}

function usableFocus(focus: BrowserFocusObservation, now: number): boolean {
  return focus.focused === true && ["normal", "private", "unknown"].includes(focus.mode)
    && typeof focus.connectionId === "string" && focus.connectionId.length > 0
    && Number.isSafeInteger(focus.tabId) && (focus.tabId as number) >= 0
    && Number.isSafeInteger(focus.windowId) && (focus.windowId as number) >= 0
    && freshTimestamp(focus.observedAt, now) && freshTimestamp(focus.receivedAt, now)
    && (focus.mode !== "normal" || (typeof focus.url === "string" && !!sanitizeBrowserUrl(focus.url)));
}

export function resolveBrowserContext(input: BrowserContextInput): BrowserContextResult {
  if (isPrivateBrowsingTitle(input.title)) return { url: "", private: true, source: "title_marker" };
  if (treeHasPrivateControl(input.axText)) return { url: "", private: true, source: "control_marker" };
  const native = input.nativeContext;
  if (native?.mode === "private") return { url: "", private: true, source: "native_context" };
  // Browser API window ids cannot be mapped to HWND here. A focused extension
  // tab therefore cannot authorize an unknown native window, even if a title or
  // page input happens to contain its URL.
  const url = native && typeof native.url === "string" ? sanitizeBrowserUrl(native.url) : "";
  if (native?.mode !== "normal" || native.complete !== true || !url
    || !native.windowId || native.windowId !== input.windowId
    || !Number.isSafeInteger(native.processId) || native.processId <= 0 || native.processId !== input.processId) {
    return { url: "", private: null, source: "unknown" };
  }
  const now = input.now ?? Date.now();
  const id = bridgeBrowserId(input.browserName);
  const snapshot = input.authority;
  const focus = id && snapshot?.version === 2 && freshTimestamp(snapshot.updatedAt, now)
    ? snapshot.browsers[id]?.focusedTab : null;
  if (focus && usableFocus(focus, now)) {
    if (focus.mode === "private") return { url: "", private: true, source: "extension" };
    if (focus.mode === "unknown") return { url: "", private: null, source: "extension_no_tab" };
    if (focus.browser !== id || sanitizeBrowserUrl(focus.url) !== url) {
      return { url: "", private: null, source: "extension_mismatch" };
    }
    return { url, private: false, source: "extension" };
  }
  return { url, private: false, source: "native_context" };
}

export function defaultBrowserAuthorityPath(): string {
  const memmyHome = process.env.MEMMY_HOME?.trim() || path.join(os.homedir(), ".memmy");
  return path.join(memmyHome, "computer-history", "browser-authority.json");
}

export function buildBrowserAuthoritySnapshot(
  connected: ReadonlyArray<"chrome" | "edge">,
  observations: ReadonlyArray<BrowserFocusObservation>,
  now = Date.now(),
): BrowserAuthoritySnapshot {
  const browsers: BrowserAuthoritySnapshot["browsers"] = {};
  for (const browser of connected) {
    // Multiple profiles can each have a last-focused window. Ambiguity never
    // resolves by array order, and publisher refresh never changes observedAt.
    const focused = observations.filter((entry) => entry.browser === browser && entry.focused);
    const focus = focused.length === 1 && usableFocus(focused[0]!, now) ? focused[0]! : null;
    browsers[browser] = { connected: true, activeUrl: null, focusedTab: focus
      ? { ...focus, url: focus.mode === "normal" ? sanitizeBrowserUrl(focus.url) : "",
        title: "" } : null };
  }
  return { version: 2, updatedAt: now, browsers };
}

export function readBrowserAuthority(file: string, now = Date.now()): BrowserAuthoritySnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrowserAuthoritySnapshot>;
    if (parsed?.version !== 2 || typeof parsed.updatedAt !== "number"
      || !freshTimestamp(parsed.updatedAt, now) || !parsed.browsers
      || typeof parsed.browsers !== "object" || Array.isArray(parsed.browsers)) return null;
    const browsers: BrowserAuthoritySnapshot["browsers"] = {};
    for (const browser of ["chrome", "edge"] as const) {
      const entry = parsed.browsers[browser];
      if (!entry || entry.connected !== true) continue;
      const focus = entry.focusedTab;
      browsers[browser] = { connected: true, activeUrl: null,
        focusedTab: focus && focus.browser === browser && usableFocus(focus, now) ? focus : null };
    }
    return { version: 2, updatedAt: parsed.updatedAt, browsers };
  } catch { return null; }
}

export function writeBrowserAuthority(file: string, snapshot: BrowserAuthoritySnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}
