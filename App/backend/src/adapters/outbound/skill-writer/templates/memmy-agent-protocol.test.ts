import { describe, expect, it } from "vitest";
import {
  MEMMY_AGENT_PROTOCOL_FIELDS,
  MEMMY_AGENT_PROTOCOL_VERSION
} from "./memmy-agent-protocol.js";
import { renderMemmyPiExtension } from "./memmy-pi-extension.js";
import { renderMemmyResumeHookScript } from "./memmy-resume-hook.js";

describe("Memmy agent protocol templates", () => {
  it.each([
    ["pi", "memmy-pi-extension", renderMemmyPiExtension()],
    ["codex", "memmy-codex-hook", renderMemmyResumeHookScript({ source: "codex", mode: "codex" })],
    ["claude_code", "memmy-claude_code-hook", renderMemmyResumeHookScript({ source: "claude_code", mode: "claude-code" })]
  ])("renders the shared lifecycle contract for %s", (source, adapterId, script) => {
    expect(script).toContain(`const MEMMY_PROTOCOL_VERSION = "${MEMMY_AGENT_PROTOCOL_VERSION}"`);
    expect(script).toContain(`const SOURCE = "${source}"`);
    expect(script).toContain(source === "pi" ? `const ADAPTER_ID = "${adapterId}"` : 'const ADAPTER_ID = "memmy-" + SOURCE + "-hook"');
    expect(script).toContain("/api/v1/sessions/open");
    expect(script).toContain("/api/v1/turns/start");
    expect(script).toContain("/complete");
    expect(script).toContain("namespace: protocolNamespace");
    expect(script).toContain("provenance: buildProtocolProvenance");
    expect(script).toContain("sourceMemoryIds");
    expect(script).toContain("readGitProvenance");
    expect(script).toContain("capturedAt: new Date().toISOString()");
  });

  it("publishes the stable v1 field inventory", () => {
    expect(MEMMY_AGENT_PROTOCOL_FIELDS).toEqual([
      "protocolVersion",
      "source",
      "adapterId",
      "requestId",
      "sessionId",
      "turnId",
      "episodeId",
      "workspacePath",
      "projectId",
      "sourceMemoryIds",
      "provenance"
    ]);
  });
});
