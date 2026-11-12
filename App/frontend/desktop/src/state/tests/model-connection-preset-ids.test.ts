import { describe, expect, it } from "vitest";
import { createModelWorkspace, modelConfigInput, upsertModelConnection } from "../model-workspace.js";

describe("model connection preset IDs", () => {
  it.each(["model entries", "model names"] as const)(
    "keeps preset IDs distinct when removing the first model and appending another (%s)",
    (inputFormat) => {
      const input = {
        provider: "openai",
        endpoint: "https://models.example.invalid/v1",
        protocol: "openai-chat-completions" as const,
        apiKey: "fixture-key"
      };
      const original = upsertModelConnection(createModelWorkspace(), "byok", {
        ...input,
        models: ["example-removed", "example-kept"]
      });
      const connection = original.workspace.spaces.byok.connections[0]!;
      const removedId = connection.presetIds["example-removed"]!;
      const keptId = connection.presetIds["example-kept"]!;

      const edited = upsertModelConnection(original.workspace, "byok", {
        ...input,
        id: connection.id,
        models: ["example-kept", "example-added"],
        ...(inputFormat === "model entries" ? {
          modelEntries: [
            { presetId: keptId, model: "example-kept", capability: "chat" },
            { model: "example-added", capability: "chat" }
          ]
        } : {})
      });
      expect(edited.error).toBeNull();

      const models = modelConfigInput(edited.workspace).providers[0]!.models;
      expect(models.map((model) => model.model).sort()).toEqual(["example-added", "example-kept"]);
      expect(models.find((model) => model.model === "example-kept")?.presetId).toBe(keptId);
      const addedId = models.find((model) => model.model === "example-added")?.presetId;
      expect(addedId).toBeTruthy();
      expect(addedId).not.toBe(keptId);
      expect(models.map((model) => model.presetId)).not.toContain(removedId);
    }
  );
});
