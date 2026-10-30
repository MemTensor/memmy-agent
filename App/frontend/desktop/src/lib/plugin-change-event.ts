/** Local UI signal; the backend remains authoritative for installed versions. */
export const PLUGIN_CHANGE_EVENT = "memmy:plugin-change";
export function notifyPluginChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PLUGIN_CHANGE_EVENT));
}
