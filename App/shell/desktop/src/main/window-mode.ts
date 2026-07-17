export type DesktopWindowMode = "full" | "pet";

export const PACKAGED_RENDERER_HOST = "127.0.0.1";
export const PACKAGED_RENDERER_DEFAULT_PORT = 19100;

export interface BootWindowModeInput {
  defaultLaunchMode: "full" | "pet" | "last";
  lastLaunchMode: "full" | "pet";
}

export function resolveBootWindowMode(input: BootWindowModeInput): DesktopWindowMode {
  if (input.defaultLaunchMode === "pet") {
    return "pet";
  }
  if (input.defaultLaunchMode === "full") {
    return "full";
  }
  return input.lastLaunchMode;
}

export interface RendererRouteTarget {
  route?: string | null;
  hash?: string | null;
  agentChatId?: string | null;
  petIntent?: "user" | null;
}

export const fullWindowButtonLeftInset = 14;
export const fullWindowButtonTopInset = 14;
export const fullWindowWorkAreaInset = 64;
export const fullWindowTitleBarOverlayHeight = 46;

export type FullWindowChromeOptions =
  | {
      titleBarStyle: "hidden";
      titleBarOverlay: {
        color: string;
        symbolColor: string;
        height: number;
      };
    }
  | {
      titleBarStyle: "hiddenInset";
      trafficLightPosition: { x: number; y: number };
    };

export interface FullWindowWorkAreaSize {
  width: number;
  height: number;
}

export const fullWindowOptions = {
  width: 1200,
  height: 780,
  minWidth: 980,
  minHeight: 640,
  title: "Memmy",
  backgroundColor: "#f1f8f7"
} as const;

/**
 * Resolves platform-specific native window chrome for the full desktop window.
 *
 * @param platform Node platform identifier for the desktop shell.
 * @returns BrowserWindow title-bar options for the requested platform.
 */
export function resolveFullWindowChromeOptions(platform: NodeJS.Platform): FullWindowChromeOptions {
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#111d1c",
        height: fullWindowTitleBarOverlayHeight
      }
    };
  }

  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: resolveFullWindowButtonPosition()
  };
}

export function resolveFullWindowButtonPosition(): { x: number; y: number } {
  return {
    x: fullWindowButtonLeftInset,
    y: fullWindowButtonTopInset
  };
}

export function resolveFullWindowSize(workArea: FullWindowWorkAreaSize): { width: number; height: number } {
  return {
    width: resolveFullWindowDimension(fullWindowOptions.width, fullWindowOptions.minWidth, workArea.width),
    height: resolveFullWindowDimension(fullWindowOptions.height, fullWindowOptions.minHeight, workArea.height)
  };
}

function resolveFullWindowDimension(target: number, minimum: number, available: number): number {
  if (!Number.isFinite(available) || available <= 0) {
    return target;
  }

  return Math.min(target, Math.max(minimum, Math.floor(available - fullWindowWorkAreaInset)));
}

export const petWindowOptions = {
  width: 160,
  height: 160,
  minWidth: 120,
  minHeight: 120,
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  visibleOnAllWorkspaces: true,
  skipTaskbar: true,
  resizable: false,
  fullscreenable: false,
  hasShadow: false,
  backgroundColor: "#00000000"
} as const;

export const petWindowAlwaysOnTopLevel = "floating" as const;

export interface PetWindowPointer {
  clientX: number;
  clientY: number;
}

export interface PetWindowLayout {
  width: number;
  height: number;
  mascotOffsetX: number;
  mascotOffsetY: number;
}

export interface PetWindowBoundsInput {
  anchorX: number;
  anchorY: number;
  layout: PetWindowLayout;
}

export interface PetWindowDragAnchorInput extends PetWindowPointer {
  cursorX: number;
  cursorY: number;
  layout: PetWindowLayout;
}

export function parsePetWindowPointer(value: unknown): PetWindowPointer | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const pointer = value as Partial<PetWindowPointer>;
  const clientX = pointer.clientX;
  const clientY = pointer.clientY;
  if (typeof clientX !== "number" || typeof clientY !== "number" || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }

  return {
    clientX,
    clientY
  };
}

export function parsePetWindowLayout(value: unknown): PetWindowLayout | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const layout = value as Partial<PetWindowLayout>;
  const width = layout.width;
  const height = layout.height;
  const mascotOffsetX = layout.mascotOffsetX;
  const mascotOffsetY = layout.mascotOffsetY;
  if (!isPositiveFinite(width) || !isPositiveFinite(height) || !isNonNegativeFinite(mascotOffsetX) || !isNonNegativeFinite(mascotOffsetY)) {
    return null;
  }

  return {
    width,
    height,
    mascotOffsetX,
    mascotOffsetY
  };
}

export function resolvePetWindowBounds(input: PetWindowBoundsInput): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(input.anchorX - input.layout.mascotOffsetX),
    y: Math.round(input.anchorY - input.layout.mascotOffsetY),
    width: Math.max(petWindowOptions.minWidth, Math.ceil(input.layout.width)),
    height: Math.max(petWindowOptions.minHeight, Math.ceil(input.layout.height))
  };
}

export function resolvePetWindowDragAnchor(input: PetWindowDragAnchorInput): { x: number; y: number } {
  return {
    x: Math.round(input.cursorX - (input.clientX - input.layout.mascotOffsetX)),
    y: Math.round(input.cursorY - (input.clientY - input.layout.mascotOffsetY))
  };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export interface ResolveRendererUrlInput {
  explicitUrl?: string;
  isPackaged: boolean;
  mainDir: string;
  mode: DesktopWindowMode;
  packagedRendererBaseUrl?: string;
  target?: RendererRouteTarget | null;
}

/** Builds the packaged renderer origin served over loopback HTTP. */
export function resolvePackagedRendererBaseUrl(
  host = PACKAGED_RENDERER_HOST,
  port = PACKAGED_RENDERER_DEFAULT_PORT
): string {
  return `http://${host}:${port}`;
}

export function appendRendererMode(url: string, mode: DesktopWindowMode, target: RendererRouteTarget | null = null): string {
  const parsed = new URL(url);
  parsed.searchParams.set("memmyMode", mode);
  if (target?.route) {
    parsed.searchParams.set("memmyRoute", target.route);
  }
  if (target?.agentChatId) {
    parsed.searchParams.set("memmyAgentChat", target.agentChatId);
  }
  if (mode === "pet" && target?.petIntent === "user") {
    parsed.searchParams.set("memmyPetIntent", "user");
  }
  if (target?.hash) {
    parsed.hash = target.hash.startsWith("#") ? target.hash : `#${target.hash}`;
  }
  return parsed.toString();
}

/**
 * Resolves the renderer page URL.
 *
 * @param input Renderer URL resolution input.
 * @returns The dev-mode Vite URL or the production local index.html URL, carrying the window launch mode.
 */
export function resolveRendererUrl(input: ResolveRendererUrlInput): string {
  const baseUrl =
    input.explicitUrl ??
    (input.isPackaged
      ? `${input.packagedRendererBaseUrl ?? resolvePackagedRendererBaseUrl()}/index.html`
      : "http://127.0.0.1:19000");

  return appendRendererMode(baseUrl, input.mode, input.target ?? null);
}
