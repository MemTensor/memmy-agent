/** Manifest tests. */
import { describe, expect, it } from "vitest";
import { createAgentAdapterDescriptor, isBuiltinAgentKind, parseAgentAdapterPluginManifest } from "../manifest.js";
import type { AgentAdapterPluginManifest } from "../types/index.js";

describe("agent adapter plugin manifest", () => {
  it("parses a manifest with default enabled and priority values", () => {
    const manifest = parseAgentAdapterPluginManifest({
      id: "cursor",
      kind: "cursor",
      displayName: "Cursor",
      version: "1.0.0",
      modulePath: "./cursor.js",
      capabilities: {
        detect: true,
        scan: true,
        installSkill: true,
        removeSkill: false
      }
    });

    expect(manifest).toEqual({
      id: "cursor",
      kind: "cursor",
      displayName: "Cursor",
      version: "1.0.0",
      modulePath: "./cursor.js",
      enabled: true,
      priority: 0,
      capabilities: {
        detect: true,
        scan: true,
        installSkill: true,
        removeSkill: false
      }
    });
  });

  it("parses explicit enabled and priority values", () => {
    const manifest = parseAgentAdapterPluginManifest({
      ...createManifest(),
      enabled: false,
      priority: 20
    });

    expect(manifest.enabled).toBe(false);
    expect(manifest.priority).toBe(20);
  });

  it("creates a descriptor from plugin manifest capabilities", () => {
    const descriptor = createAgentAdapterDescriptor(createManifest());

    expect(descriptor).toEqual({
      id: "codex",
      kind: "codex",
      displayName: "Codex",
      version: "1.0.0",
      capabilities: {
        detect: true,
        scan: false,
        installSkill: true,
        removeSkill: false
      }
    });
  });

  it("identifies builtin agent kinds without blocking custom plugin kinds", () => {
    expect(isBuiltinAgentKind("cursor")).toBe(true);
    expect(isBuiltinAgentKind("workbuddy")).toBe(true);
    expect(isBuiltinAgentKind("third_party_agent")).toBe(false);
    expect(isBuiltinAgentKind(1)).toBe(false);
    expect(parseAgentAdapterPluginManifest({ ...createManifest(), kind: "third_party_agent" }).kind).toBe(
      "third_party_agent"
    );
  });

  it("rejects invalid manifest shapes", () => {
    expect(() => parseAgentAdapterPluginManifest(null)).toThrow("must be an object");
    expect(() => parseAgentAdapterPluginManifest([])).toThrow("must be an object");
    expect(() => parseAgentAdapterPluginManifest({ ...createManifest(), id: " " })).toThrow(
      "id must be a non-empty string"
    );
    expect(() => parseAgentAdapterPluginManifest({ ...createManifest(), kind: " " })).toThrow(
      "kind must be a non-empty string"
    );
    expect(() => parseAgentAdapterPluginManifest({ ...createManifest(), kind: 1 })).toThrow(
      "kind must be a non-empty string"
    );
    expect(() => parseAgentAdapterPluginManifest({ ...createManifest(), enabled: "yes" })).toThrow(
      "enabled must be a boolean"
    );
    expect(() => parseAgentAdapterPluginManifest({ ...createManifest(), priority: Number.NaN })).toThrow(
      "priority must be a finite number"
    );
    expect(() => parseAgentAdapterPluginManifest({ ...createManifest(), capabilities: null })).toThrow(
      "capabilities must be an object"
    );
    expect(() =>
      parseAgentAdapterPluginManifest({
        ...createManifest(),
        capabilities: { detect: "yes", scan: false, installSkill: true, removeSkill: false }
      })
    ).toThrow("capabilities.detect must be a boolean");
  });
});

/** Creates create manifest. */
function createManifest(): AgentAdapterPluginManifest {
  return {
    id: "codex",
    kind: "codex",
    displayName: "Codex",
    version: "1.0.0",
    modulePath: "./codex.js",
    enabled: true,
    priority: 10,
    capabilities: {
      detect: true,
      scan: false,
      installSkill: true,
      removeSkill: false
    }
  };
}
