import { describe, expect, it } from "vitest";
import { formatConversationTitleForDisplay } from "../format-conversation-title.js";

const ELLIPSIS = "…";

describe("formatConversationTitleForDisplay", () => {
  it("keeps short titles unchanged", () => {
    expect(formatConversationTitleForDisplay("整理会议纪要")).toBe("整理会议纪要");
  });

  it("truncates long file paths at the end", () => {
    const title = "/Users/zongy/Documents/MemTensor/Playground/src/main/resources/db/agent_quota_usage_record_add_usage_columns_20260713.sql";
    const display = formatConversationTitleForDisplay(title);

    expect(display.length).toBe(52);
    expect(display.endsWith(ELLIPSIS)).toBe(true);
    expect(display.startsWith("/Users/zongy/Documents/MemTensor/Playground/src/")).toBe(true);
  });

  it("truncates regular long text at the end", () => {
    const title = "请帮我总结今天所有会议纪要并列出后续行动项和每个负责人的截止时间以及需要同步给团队的结论";
    const display = formatConversationTitleForDisplay(title, 24);

    expect(display.endsWith(ELLIPSIS)).toBe(true);
    expect(display.length).toBe(24);
  });
});
