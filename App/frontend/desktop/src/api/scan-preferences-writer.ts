import type { OnboardingStateDto, ScanPermission, ScanPreferences } from "@memmy/local-api-contracts";
import type { ConfigClient } from "./config-client.js";

// Keep the queue with the client so navigating away/back cannot reorder writes.
const writers = new WeakMap<ConfigClient, ReturnType<typeof createWriter>>();

export function scanPreferencesWriter(client: ConfigClient) {
  let writer = writers.get(client);
  if (!writer) {
    writer = createWriter(client);
    writers.set(client, writer);
  }
  return writer;
}

function createWriter(client: ConfigClient) {
  let tail = Promise.resolve();
  let revision = 0;
  let pending = 0;
  let confirmed: ScanPreferences;
  let permission: ScanPermission;
  return {
    get revision() { return revision; },
    canRefresh(startRevision: number) { return pending === 0 && startRevision === revision; },
    write(input: {
      patch: Partial<ScanPreferences>;
      previous: ScanPreferences;
      permission: ScanPermission;
      onOnboarding: (value: Partial<OnboardingStateDto>) => void;
      onConfirmed: (value: ScanPreferences) => void;
      onError: (error: unknown) => void;
    }): Promise<void> {
      if (pending === 0) {
        confirmed = input.previous;
        permission = input.permission;
      }
      pending += 1;
      const ownRevision = ++revision;
      tail = tail.then(async () => {
        try {
          const grant = input.patch.autoInjectSkill === true ? "scan_and_write_skill"
            : (input.patch.autoScanKnownAgents === true || input.patch.watchFileChanges === true)
              && permission !== "scan_only" && permission !== "scan_and_write_skill" ? "scan_only" : undefined;
          if (grant) {
            const onboarding = await client.updateOnboarding({ scanPermission: grant });
            permission = onboarding.scanPermission ?? grant;
            input.onOnboarding(onboarding);
          }
          confirmed = await client.updateScanPreferences(input.patch);
          if (ownRevision === revision) input.onConfirmed(confirmed);
        } catch (error) {
          if (ownRevision === revision) {
            input.onConfirmed(confirmed);
            input.onError(error);
          }
        } finally {
          pending -= 1;
        }
      });
      return tail;
    }
  };
}
