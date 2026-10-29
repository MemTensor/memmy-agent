import type { BrowserTaskSitePermission } from '@memmy/local-api-contracts';

const TASK_PERMISSION_LIMIT_MS = 30 * 60_000;
type TaskChoice = { allowed: boolean; expiresAt: number; isCurrent: () => boolean };

/**
 * Agent device choices for one in-app tab and origin. They are never saved, take precedence
 * over the saved site setting on that tab only, and end with the tab, a move to another
 * origin, the Agent turn or process, or the time limit.
 */
export class BrowserTaskSitePermissions {
  private readonly tabs = new Map<number, { origin: string; choices: Map<string, TaskChoice> }>();

  set(tabId: number, origin: string, permission: BrowserTaskSitePermission, allowed: boolean,
    isCurrent: () => boolean): void {
    const existing = this.tabs.get(tabId);
    const tab = existing?.origin === origin ? existing : { origin, choices: new Map<string, TaskChoice>() };
    tab.choices.set(permission, { allowed, expiresAt: Date.now() + TASK_PERMISSION_LIMIT_MS, isCurrent });
    this.tabs.set(tabId, tab);
  }

  /** The live choice for this tab and origin; undefined leaves the saved site setting in effect. */
  decision(tabId: number, origin: string, permission: string): boolean | undefined {
    const tab = this.tabs.get(tabId);
    const choice = tab?.origin === origin ? tab.choices.get(permission) : undefined;
    if (!tab || !choice) return undefined;
    if (choice.expiresAt > Date.now() && choice.isCurrent()) return choice.allowed;
    tab.choices.delete(permission);
    if (tab.choices.size === 0) this.tabs.delete(tabId);
    return undefined;
  }

  /** Ends the tab's choices unless its main-frame `url` is still on their origin. */
  end(tabId: number, url?: string): void {
    let sameOrigin = false;
    try { sameOrigin = url !== undefined && new URL(url).origin === this.tabs.get(tabId)?.origin; }
    catch { /* An unparsable page address keeps no task choice. */ }
    if (!sameOrigin) this.tabs.delete(tabId);
  }
}
