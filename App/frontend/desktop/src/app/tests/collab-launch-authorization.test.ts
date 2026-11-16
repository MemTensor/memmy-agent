/**
 * 大卡「新建项目」之后的后台授权：它在大卡卸载后继续跑，结果交给看板。
 *
 * 这里只测模块本身：授权进行中视为已授权、全部成功不留痕迹、个别失败与整体失败分别记下可以重试的东西、
 * 计数拿不到时退化成不带数字的说法。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessView, CollabClient } from "../../api/collab-client.js";
import {
  getLaunchAuthorizationState,
  isLaunchAuthorizationInFlight,
  resetLaunchAuthorizationRuntime,
  retryLaunchAuthorization,
  startLaunchAuthorization
} from "../collab-launch-authorization.js";

const agents: CollabAgentAccessView["agents"] = [
  { sourceId: "claude_code", name: "Claude Code", available: true, enabled: true, installed: false, added: false },
  { sourceId: "codex", name: "Codex", available: true, enabled: true, installed: false, added: false }
];

function view(overrides: Partial<CollabAgentAccessView> = {}): CollabAgentAccessView {
  return { granted: false, askedInProject: false, agents, ...overrides };
}

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    getAgentAccess: vi.fn().mockResolvedValue(view()),
    setAgentAccess: vi.fn().mockResolvedValue({ view: view({ granted: true }), results: [] }),
    installAgentAccess: vi.fn().mockResolvedValue({ view: view({ granted: true }), results: [] }),
    ...overrides
  } as unknown as CollabClient;
}

beforeEach(() => {
  resetLaunchAuthorizationRuntime();
});

describe("collab launch authorization", () => {
  it("treats the authorization as in flight until it settles, then records only what is left", async () => {
    const collab = client({
      setAgentAccess: vi.fn().mockResolvedValue({
        view: view({ granted: true }),
        results: [
          { sourceId: "claude_code", name: "Claude Code", ok: true },
          { sourceId: "codex", name: "Codex", ok: true }
        ]
      })
    });

    startLaunchAuthorization(collab);
    // 同步返回：大卡关掉时不必等它。
    expect(isLaunchAuthorizationInFlight()).toBe(true);

    await vi.waitFor(() => expect(isLaunchAuthorizationInFlight()).toBe(false));
    expect(getLaunchAuthorizationState()).toEqual({ inFlight: false, granted: true, failure: null });
  });

  it("remembers the agents that did not install, and retries only those", async () => {
    const installAgentAccess = vi.fn().mockResolvedValue({
      view: view({ granted: true }),
      results: [{ sourceId: "codex", name: "Codex", ok: true }]
    });
    const collab = client({
      setAgentAccess: vi.fn().mockResolvedValue({
        view: view({ granted: true }),
        results: [
          { sourceId: "claude_code", name: "Claude Code", ok: true },
          { sourceId: "codex", name: "Codex", ok: false, message: "技能目录不存在" }
        ]
      }),
      installAgentAccess
    });

    startLaunchAuthorization(collab);
    await vi.waitFor(() => expect(getLaunchAuthorizationState().failure).not.toBeNull());
    expect(getLaunchAuthorizationState().failure).toEqual({ count: 1, sourceIds: ["codex"] });

    retryLaunchAuthorization(collab);
    expect(isLaunchAuthorizationInFlight()).toBe(true);
    await vi.waitFor(() => expect(getLaunchAuthorizationState().failure).toBeNull());
    expect(installAgentAccess).toHaveBeenCalledWith(["codex"]);
    expect(getLaunchAuthorizationState().granted).toBe(true);
  });

  it("counts the agents still missing when the whole request fails", async () => {
    const collab = client({ setAgentAccess: vi.fn().mockRejectedValue(new Error("offline")) });

    startLaunchAuthorization(collab);
    await vi.waitFor(() => expect(getLaunchAuthorizationState().failure).not.toBeNull());
    // 两个可用且已开启的 Agent 都没装上。
    expect(getLaunchAuthorizationState().failure).toEqual({ count: 2, sourceIds: [] });
    expect(getLaunchAuthorizationState().granted).toBe(false);
  });

  it("falls back to the count-free wording when this computer cannot say how many agents are left", async () => {
    const collab = client({
      setAgentAccess: vi.fn().mockRejectedValue(new Error("offline")),
      getAgentAccess: vi.fn().mockRejectedValue(new Error("offline"))
    });

    startLaunchAuthorization(collab);
    await vi.waitFor(() => expect(getLaunchAuthorizationState().failure).not.toBeNull());
    expect(getLaunchAuthorizationState().failure).toEqual({ count: null, sourceIds: [] });
  });

  it("retries the whole request when the authorization itself failed", async () => {
    const setAgentAccess = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ view: view({ granted: true }), results: [] });
    const installAgentAccess = vi.fn();
    const collab = client({ setAgentAccess, installAgentAccess });

    startLaunchAuthorization(collab);
    await vi.waitFor(() => expect(getLaunchAuthorizationState().failure).not.toBeNull());

    retryLaunchAuthorization(collab);
    await vi.waitFor(() => expect(getLaunchAuthorizationState().failure).toBeNull());
    expect(setAgentAccess).toHaveBeenCalledTimes(2);
    expect(installAgentAccess).not.toHaveBeenCalled();
  });

  it("ignores a second start and a retry without anything pending", () => {
    const collab = client();
    startLaunchAuthorization(collab);
    startLaunchAuthorization(collab);
    retryLaunchAuthorization(collab);
    expect(collab.setAgentAccess).toHaveBeenCalledTimes(1);
    expect(collab.installAgentAccess).not.toHaveBeenCalled();
  });
});
