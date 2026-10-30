import { randomUUID } from "node:crypto";
import type { L3UserProjectsReplaceRequest } from "@memmy/local-api-contracts";
import type { WebuiProjectRegistrySnapshot } from "../entrypoints/frontend-bridge/projects.js";
import type { MemmyMemoryClient } from "./client.js";

export const L3_USER_PROJECT_SYNC_INTERVAL_MS = 60_000;
/** An unchanged list is still pushed this often, so Memory gets it back after its data was cleared. */
export const L3_USER_PROJECT_RESYNC_MS = 10 * 60_000;

type Envelope = Omit<L3UserProjectsReplaceRequest, "requestId" | "projects" | "standaloneRoots">;

/**
 * Keeps Memory's copy of the user's selected project folders current. It reads
 * the registry on a timer and pushes the full list only when it differs from
 * the last successful push, so startup, edits made by any process and a Memory
 * service that was not reachable yet are all covered by the same loop. An
 * unchanged list is pushed again every ten minutes in case Memory lost it.
 */
export class L3UserProjectSync {
  private lastPushedKey: string | null = null;
  private lastPushedAt = 0;
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    client: Pick<MemmyMemoryClient, "replaceL3UserProjects">;
    envelope: Envelope;
    readProjects: () => WebuiProjectRegistrySnapshot;
    standaloneRoots: () => string[];
    intervalMs?: number;
    now?: () => number;
  }) {}

  start(): void {
    if (this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), this.options.intervalMs ?? L3_USER_PROJECT_SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Pushes when the list changed or the last push failed; never throws. A corrupt registry is not pushed. */
  syncNow(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pushIfChanged().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pushIfChanged(): Promise<boolean> {
    let snapshot: WebuiProjectRegistrySnapshot;
    try {
      snapshot = this.options.readProjects();
    } catch {
      return false;
    }
    if (snapshot.state !== "ready") return false;
    const projects = snapshot.projects.map((project) => ({ rootPath: project.rootPath, name: project.name }));
    const standaloneRoots = this.options.standaloneRoots();
    const key = JSON.stringify({ projects, standaloneRoots });
    const now = (this.options.now ?? Date.now)();
    if (key === this.lastPushedKey && now - this.lastPushedAt < L3_USER_PROJECT_RESYNC_MS) return true;
    try {
      await this.options.client.replaceL3UserProjects({
        ...this.options.envelope,
        requestId: randomUUID(),
        projects,
        standaloneRoots
      });
      this.lastPushedKey = key;
      this.lastPushedAt = now;
      return true;
    } catch {
      return false;
    }
  }
}
