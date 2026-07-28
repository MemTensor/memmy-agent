import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLoop,
  SessionWorkspaceError,
} from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { Session } from "../../../src/core/session/manager.js";
import { ProjectStore } from "../../../src/entrypoints/frontend-bridge/projects.js";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeLoop(profileWorkspace: string, projectStore: ProjectStore | null = null): AgentLoop {
  return new AgentLoop({
    workspace: profileWorkspace,
    projectStore,
    provider: {
      generation: { maxTokens: 256 },
      getDefaultModel: () => "test-model",
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentLoop Session workspace", () => {
  it("keeps non-WebUI channels on the profile workspace", () => {
    const profile = tempRoot("memmy-profile-");
    const loop = makeLoop(profile);
    const message = new InboundMessage({
      channel: "cli",
      chatId: "cli",
      senderId: "user",
      content: "hello",
    });

    expect(loop.resolveSessionWorkspace(message, null)).toEqual({
      projectId: null,
      cwd: loop.workspace,
    });
  });

  it("requires an explicit binding reservation for a new WebUI Session", () => {
    const profile = tempRoot("memmy-profile-");
    const loop = makeLoop(profile);
    const message = new InboundMessage({
      channel: "websocket",
      chatId: "chat",
      senderId: "user",
      content: "hello",
      metadata: { webui: true },
    });

    expect(() => loop.resolveSessionWorkspace(message, null)).toThrowError(
      expect.objectContaining({ code: "workspace_missing" }),
    );

    const binding = { projectId: null, cwd: fs.realpathSync(profile) };
    expect(loop.resolveSessionWorkspace(message, null, binding)).toEqual(binding);
  });

  it("uses the immutable Session binding after project rename and pin changes", () => {
    const profile = tempRoot("memmy-profile-");
    const projectRoot = tempRoot("memmy-project-");
    const store = new ProjectStore({ filePath: path.join(profile, "projects.json") });
    const project = store.add(projectRoot, "existing");
    const loop = makeLoop(profile, store);
    const session = new Session({
      key: "websocket:chat",
      metadata: {
        webui: true,
        webuiProjectId: project.id,
        webuiWorkspaceCwd: fs.realpathSync(projectRoot),
      },
    });
    const message = new InboundMessage({
      channel: "websocket",
      chatId: "chat",
      senderId: "user",
      content: "hello",
      metadata: { webui: true },
    });

    store.rename(project.id, "Renamed");
    store.setPinned(project.id, true);

    expect(loop.resolveSessionWorkspace(message, session)).toEqual({
      projectId: project.id,
      cwd: fs.realpathSync(projectRoot),
    });
  });

  it("fails instead of falling back when the bound directory disappears", () => {
    const profile = tempRoot("memmy-profile-");
    const sessionRoot = tempRoot("memmy-session-root-");
    const loop = makeLoop(profile);
    const session = new Session({
      key: "websocket:chat",
      metadata: {
        webui: true,
        webuiProjectId: null,
        webuiWorkspaceCwd: fs.realpathSync(sessionRoot),
      },
    });
    fs.rmdirSync(sessionRoot);

    expect(() => loop.resolveSessionWorkspace(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat",
        senderId: "user",
        content: "hello",
        metadata: { webui: true },
      }),
      session,
    )).toThrowError(SessionWorkspaceError);
  });

  it("renders only the task workspace in the model identity", () => {
    const profile = tempRoot("memmy-profile-");
    const projectRoot = tempRoot("memmy-project-");
    const loop = makeLoop(profile);
    const identity = loop.context.getIdentity("websocket", fs.realpathSync(projectRoot));

    expect(identity).toContain(`Your workspace is at: ${fs.realpathSync(projectRoot)}`);
    expect(identity).not.toContain(`Your workspace is at: ${fs.realpathSync(profile)}`);
    expect(identity).not.toContain("Memmy profile workspace:");
  });
});
