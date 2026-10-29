/**
 * One Memmy task sends input to a native app at a time: keystrokes and pastes
 * reach the app's focused window, so parallel tasks would type into each
 * other's documents. A lease ends when its task closes or after it stays idle.
 */
export class NativeAppLeases {
  private readonly holders = new Map<string, { owner: string; usedAt: number }>();

  constructor(private readonly idleMs = 60_000, private readonly now: () => number = Date.now) {}

  heldByOther(appKey: string, owner: string): boolean {
    const lease = this.holders.get(appKey);
    if (!lease || lease.owner === owner) return false;
    if (this.now() - lease.usedAt < this.idleMs) return true;
    this.holders.delete(appKey);
    return false;
  }

  claim(appKey: string, owner: string): void {
    this.holders.set(appKey, { owner, usedAt: this.now() });
  }

  touch(appKey: string, owner: string): void {
    const lease = this.holders.get(appKey);
    if (lease?.owner === owner) lease.usedAt = this.now();
  }

  release(owner: string): void {
    for (const [appKey, lease] of this.holders) if (lease.owner === owner) this.holders.delete(appKey);
  }
}
