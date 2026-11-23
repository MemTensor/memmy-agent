/**
 * 草稿的共享选择：在已共享的项目里新建任务默认共享给成员，草稿里关掉的保持不共享；
 * 不在已共享项目里的草稿、以及已有任务都不受这个默认值影响。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../api/collab-client.js";
import {
  draftShareIntent,
  handOffDraftShare,
  isSharePending,
  resetShareIntents,
  setDraftShareIntent,
  takeDraftShareIntent
} from "../collab-share-intent.js";

function client(setTaskSharing = vi.fn().mockResolvedValue({ shared: true, synced: false, started: 0 })) {
  return { setTaskSharing } as unknown as Pick<CollabClient, "setTaskSharing"> & { setTaskSharing: typeof setTaskSharing };
}

describe("collab share intent", () => {
  afterEach(() => {
    resetShareIntents();
  });

  it("starts a draft as shared and remembers when the person turns it off", () => {
    expect(draftShareIntent("draft-1")).toBe(true);
    setDraftShareIntent("draft-1", false);
    expect(draftShareIntent("draft-1")).toBe(false);
    // 其他草稿不受影响。
    expect(draftShareIntent("draft-2")).toBe(true);
  });

  it("takes the choice once and forgets it afterwards", () => {
    setDraftShareIntent("draft-1", false);
    expect(takeDraftShareIntent("draft-1", true)).toBe(false);
    // 取过之后回到默认值：这张草稿已经交给了会话。
    expect(draftShareIntent("draft-1")).toBe(true);
    expect(takeDraftShareIntent("draft-2", true)).toBe(true);
  });

  it("never shares a draft outside a shared project", () => {
    expect(takeDraftShareIntent("draft-1", false)).toBe(false);
    setDraftShareIntent("draft-2", true);
    expect(takeDraftShareIntent("draft-2", false)).toBe(false);
  });

  it("shares a new session from a shared project by default", async () => {
    const collab = client();
    const handed = handOffDraftShare({ collab, onlineProjectId: "cloud-1", draftScopeKey: "draft-3", chatId: "chat-3" });
    expect(handed).not.toBeNull();
    expect(collab.setTaskSharing).toHaveBeenCalledWith("cloud-1", "chat-3", true);
    // 本机记录写好之前，开关按「已共享」显示。
    expect(isSharePending("chat-3")).toBe(true);
    await handed;
    expect(isSharePending("chat-3")).toBe(false);
  });

  it("keeps a session unshared when the person turned the draft off", () => {
    const collab = client();
    setDraftShareIntent("draft-4", false);
    expect(handOffDraftShare({ collab, onlineProjectId: "cloud-1", draftScopeKey: "draft-4", chatId: "chat-4" })).toBeNull();
    expect(collab.setTaskSharing).not.toHaveBeenCalled();
    expect(isSharePending("chat-4")).toBe(false);
  });

  it("does nothing for a local project or without collaboration", () => {
    const collab = client();
    expect(handOffDraftShare({ collab, onlineProjectId: null, draftScopeKey: "draft-5", chatId: "chat-5" })).toBeNull();
    expect(handOffDraftShare({ collab: null, onlineProjectId: "cloud-1", draftScopeKey: "draft-6", chatId: "chat-6" })).toBeNull();
    expect(collab.setTaskSharing).not.toHaveBeenCalled();
    // 草稿的选择照样被取走，不会留给之后复用这个 scope key 的草稿。
    setDraftShareIntent("draft-5", false);
    handOffDraftShare({ collab, onlineProjectId: null, draftScopeKey: "draft-5", chatId: "chat-5" });
    expect(draftShareIntent("draft-5")).toBe(true);
  });

  it("drops the pending state when saving fails", async () => {
    const collab = client(vi.fn().mockRejectedValue(new Error("cloud down")));
    const handed = handOffDraftShare({ collab, onlineProjectId: "cloud-1", draftScopeKey: "draft-7", chatId: "chat-7" });
    expect(isSharePending("chat-7")).toBe(true);
    await expect(handed).resolves.toBeUndefined();
    expect(isSharePending("chat-7")).toBe(false);
  });
});
