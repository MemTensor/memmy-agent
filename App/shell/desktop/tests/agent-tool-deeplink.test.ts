import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAgentToolPromptDeepLink } from "../src/main/agent-tool-deeplink.js";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));

describe("agent tool prompt deeplinks", () => {
  it("opens WorkBuddy via the task start deeplink with /memmy-memory prefixed", () => {
    const prompt = "请接着我刚才在 Memmy 里的初见报告继续聊天。";
    expect(buildAgentToolPromptDeepLink("workbuddy", prompt)).toBe(
      `workbuddy://task?action=start&prompt=${encodeURIComponent(`/memmy-memory ${prompt}`)}`
    );
  });

  it("keeps WorkBuddy on the GUI handoff path without a Terminal fallback", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");

    expect(mainSource).toContain('if (request.sourceId === "workbuddy")');
    expect(mainSource).toContain("return { opened: await openWorkBuddyAppFallback() };");
    expect(mainSource).not.toContain("workbuddyBinaryCandidates");
    expect(mainSource).not.toContain("openDirectPromptTerminal(prompt, workbuddyBinaryCandidates");
  });
});
