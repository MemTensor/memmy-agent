import type { DesktopUpdateCheckResult } from "@memmy/desktop-interface";

/** Prefer an available NSIS package; otherwise offer the Web Install transition. */
export const checkLegacyUpdateThenStore = async (options: {
  checkLegacy: () => Promise<DesktopUpdateCheckResult>;
  checkStore: () => Promise<DesktopUpdateCheckResult | null>;
}): Promise<DesktopUpdateCheckResult> => {
  let legacy: DesktopUpdateCheckResult;
  try { legacy = await options.checkLegacy(); }
  catch (error) {
    const store = await options.checkStore();
    if (store) return store;
    throw error;
  }
  if (legacy.status === "available" && (legacy.downloadUrl || legacy.preparedUpdate)) return legacy;
  return await options.checkStore() ?? legacy;
};
