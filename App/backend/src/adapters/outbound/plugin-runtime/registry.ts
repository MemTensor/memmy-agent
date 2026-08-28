/** Plugin runtime adapter registry. */
import type { PluginAdapter } from "./types.js";

export class PluginAdapterRegistry {
  private readonly adapters = new Map<string, PluginAdapter>();

  constructor(adapters: PluginAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: PluginAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate plugin adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get(id: string): PluginAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw Object.assign(new Error(`Unsupported plugin adapter: ${id}`), {
      code: "plugin_adapter_unsupported"
    });
    return adapter;
  }
}
