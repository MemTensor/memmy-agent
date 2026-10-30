import { ComputerHistoryDemoService as SharedService, ComputerHistoryApiError } from "../core/computer-history-api.js";
import { WindowsPlatformDriver } from "./platform-driver.js";
import { parseWindowsSettings, WindowsSettingsStore } from "./settings.js";
import { collectorGate, CollectorBusyError } from "../core/collector-gate.js";

export class WindowsComputerHistoryService extends SharedService {
  private readonly driver: WindowsPlatformDriver;
  constructor(input: ConstructorParameters<typeof SharedService>[0] & { binary?: string; windowsSettingsFile?: string } = {}) {
    const store = new WindowsSettingsStore(input.windowsSettingsFile);
    const driver = new WindowsPlatformDriver(store, input.binary, input.recorderScript);
    super({ ...input, platformDriver: driver });
    this.driver = driver;
  }
  getWindowsConfiguration() { return this.driver.configuration(); }
  async updateWindowsSettings(input: unknown) {
    if (collectorGate.taskActive) throw new CollectorBusyError();
    let settings;
    try { settings = parseWindowsSettings(input); }
    catch { throw new ComputerHistoryApiError(422, "Invalid Windows Computer History settings"); }
    // Revoke capture before acknowledging changes to persistent consent.
    const state = this.snapshot().observation.state;
    if (state !== "stopped") await this.stopObservation();
    try { this.driver.store.write(settings); }
    catch { throw new ComputerHistoryApiError(503, "Unable to save Windows Computer History settings"); }
    await this.checkPermissions();
    return this.getWindowsConfiguration();
  }
}
let service: WindowsComputerHistoryService | null = null;
export function getWindowsComputerHistoryService(): WindowsComputerHistoryService { return service ??= new WindowsComputerHistoryService(); }
