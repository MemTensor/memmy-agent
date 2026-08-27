/** Open url module. */

/** Handles open url. */
export async function openUrl(rawUrl: string): Promise<void> {
  const url = rawUrl.trim();

  if (typeof window === "undefined") {
    return;
  }

  if (typeof window.memmy?.openExternal === "function") {
    try {
      await window.memmy.openExternal(url);
      return;
    } catch (error) {
      console.warn("[tools] openExternal failed; falling back to window.open:", error);
    }
  }

  if (typeof window.open !== "function") {
    console.warn("[tools] window.open is unavailable; external URL request ignored:", url);
    return;
  }

  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    console.warn("[tools] window.open failed; external URL request ignored:", error);
  }
}

/** Definition for open external url. */
export const openExternalUrl = openUrl;
