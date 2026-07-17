export interface RendererKeyboardInput {
  type?: string;
  key?: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function shouldBlockRendererReloadShortcut(input: RendererKeyboardInput): boolean {
  if (input.type !== "keyDown" || input.alt) {
    return false;
  }

  const key = input.key?.toLowerCase();
  const code = input.code?.toLowerCase();
  const isReloadKey = key === "r" || code === "keyr";
  return isReloadKey && (input.meta === true || input.control === true);
}
