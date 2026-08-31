import { describe, expect, it } from "vitest";
import {
  CapabilityEventSchema,
  PluginCapabilityEventPayloadSchema,
  PluginManifestSchema,
  type PluginManifest
} from "../src/plugin.js";

const manifest: PluginManifest = {
  apiVersion: "memmy/v1",
  id: "com.example.literature-review",
  name: "Literature Review",
  version: "1.0.0",
  runtime: { adapter: "http", config: { baseUrl: "https://plugin.example" } },
  capabilities: [
    {
      id: "review",
      name: "Review literature",
      description: "Search and summarize literature",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "job"
    }
  ],
  permissions: [{ type: "network", hosts: ["plugin.example"] }]
};

describe("PluginManifestSchema", () => {
  it("accepts a language-independent plugin manifest", () => {
    expect(PluginManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects duplicate capability ids", () => {
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      capabilities: [manifest.capabilities[0], manifest.capabilities[0]]
    })).toThrow(/Duplicate capability id/);
  });

  it("requires explicit permissions even when empty", () => {
    const { permissions: _permissions, ...withoutPermissions } = manifest;
    expect(() => PluginManifestSchema.parse(withoutPermissions)).toThrow();
  });

  it("accepts a scoped renderer and rejects unsafe or unknown entries", () => {
    expect(PluginManifestSchema.parse({
      ...manifest,
      ui: { renderer: { entry: "ui/index.html", capabilities: ["review"], height: 320 } }
    }).ui?.renderer).toEqual({ entry: "ui/index.html", capabilities: ["review"], height: 320 });

    expect(() => PluginManifestSchema.parse({
      ...manifest,
      ui: { renderer: { entry: "../outside.html" } }
    })).toThrow(/safe relative path/);
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      ui: { renderer: { entry: "ui/index.html", capabilities: ["missing"] } }
    })).toThrow(/Unknown renderer capability/);
  });

  it("registers commands and a full plugin surface against declared capabilities", () => {
    const parsed = PluginManifestSchema.parse({
      ...manifest,
      commands: [{ command: "/review", name: "Review", description: "Create a review", capabilityId: "review", surface: true }],
      ui: { surface: { entry: "ui/surface.html", capabilities: ["review"] } }
    });
    expect(parsed.commands?.[0]?.command).toBe("/review");
    expect(parsed.ui?.surface?.entry).toBe("ui/surface.html");
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      commands: [{ command: "/review", name: "Review", description: "Create a review", capabilityId: "missing" }]
    })).toThrow(/Unknown command capability/);
  });
});

describe("CapabilityEventSchema", () => {
  it("keeps progress non-blocking and interaction explicit", () => {
    expect(CapabilityEventSchema.parse({ type: "progress", current: 1, total: 3 })).toEqual({
      type: "progress",
      current: 1,
      total: 3
    });
    expect(CapabilityEventSchema.parse({
      type: "interaction",
      request: { interactionId: "question-1", type: "question", payload: { title: "Scope" } }
    }).type).toBe("interaction");
  });

  it("wraps generic plugin events with call routing context", () => {
    expect(PluginCapabilityEventPayloadSchema.parse({
      pluginId: manifest.id,
      capabilityId: "review",
      callId: "call-1",
      conversationId: "conversation-1",
      event: { type: "artifact", artifact: { id: "report", name: "report.md", mediaType: "text/markdown", uri: "file:///report.md" } }
    }).event.type).toBe("artifact");
  });
});
