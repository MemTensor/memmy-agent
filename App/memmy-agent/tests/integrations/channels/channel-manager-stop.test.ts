import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

describe("ChannelManager Stop routing", () => {
  it("passes the current-turn Stop callback through to WebSocket channels", () => {
    const stopCurrentTurn = vi.fn(async () => 1);
    const manager = new ChannelManager({ channels: { websocket: { enabled: true } } }, new MessageBus(), { stopCurrentTurn });
    expect(manager.stopCurrentTurn).toBe(stopCurrentTurn);
    expect((manager.getChannel("websocket") as WebSocketChannel).stopCurrentTurn).toBe(stopCurrentTurn);
    expect(manager.channelRuntimeOptions("telegram")).not.toHaveProperty("stopCurrentTurn");
  });
});
