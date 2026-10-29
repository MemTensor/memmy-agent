/** Provides a recovery entry without changing the persisted tray preference. */
export function createPIPTrayRecovery(host: {
  hasTray(): boolean; showTray(): void; removeTray(): void; updateMenu(): void;
}) {
  let temporary = false;
  return {
    trayRequested(enabled: boolean, hiddenActive: boolean): boolean {
      temporary = !enabled && hiddenActive;
      return enabled || hiddenActive;
    },
    visibilityChanged(hiddenActive: boolean): void {
      if (hiddenActive && !host.hasTray()) {
        temporary = true;
        host.showTray();
      } else if (!hiddenActive && temporary) {
        temporary = false;
        host.removeTray();
      } else host.updateMenu();
    },
  };
}
