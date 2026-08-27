import fs from "node:fs";
import path from "node:path";
import {
  modelCatalogFingerprint,
  readModelCatalog,
} from "./model-catalog.js";

export class ModelCatalogWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private fingerprint: string;
  private refreshGeneration = 0;

  constructor(
    private readonly configPath: string,
    private readonly onChange: (
      status: "ready" | "invalid",
      fingerprint: string
    ) => void,
  ) {
    this.fingerprint = modelCatalogFingerprint(configPath);
  }

  start(): void {
    if (this.watcher || this.closed) return;
    const target = path.resolve(this.configPath);
    const directory = path.dirname(target);
    const basename = path.basename(target);
    fs.mkdirSync(directory, { recursive: true });
    this.watcher = fs.watch(directory, (_event, filename) => {
      if (filename && String(filename) !== basename) return;
      this.schedule();
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private schedule(): void {
    if (this.closed) return;
    const generation = ++this.refreshGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh(generation);
    }, 150);
    this.timer.unref?.();
  }

  private async refresh(generation: number): Promise<void> {
    for (const delayMs of [0, 50, 100, 200]) {
      if (this.closed || generation !== this.refreshGeneration) return;
      if (delayMs) await delay(delayMs);
      if (this.closed || generation !== this.refreshGeneration) return;
      const next = modelCatalogFingerprint(this.configPath);
      if (next === "invalid") continue;
      try {
        readModelCatalog(this.configPath);
      } catch {
        continue;
      }
      if (
        this.closed
        || generation !== this.refreshGeneration
        || next === this.fingerprint
      ) return;
      this.fingerprint = next;
      this.onChange("ready", next);
      return;
    }
    if (
      !this.closed
      && generation === this.refreshGeneration
      && this.fingerprint !== "invalid"
    ) {
      this.fingerprint = "invalid";
      this.onChange("invalid", "invalid");
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
