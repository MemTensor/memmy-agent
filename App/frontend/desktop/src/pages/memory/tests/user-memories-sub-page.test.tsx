import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import {
  buildUserMemoryPanelItemsInput,
  UserMemoriesSubPage
} from "../user-memories-sub-page.js";

describe("UserMemoriesSubPage", () => {
  it("uses the independent UserMemory panel layer", () => {
    expect(buildUserMemoryPanelItemsInput("  苹果  ", 2)).toEqual({
      layer: "UserMemory",
      q: "苹果",
      page: 2
    });
  });

  it("renders a separate User Memory management section", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <UserMemoriesSubPage client={null} />
      </I18nProvider>
    );
    expect(html).toContain("用户记忆");
    expect(html).toContain('data-icon="user-round"');
    expect(html).toContain("用户事实、生活偏好和稳定工作偏好");
    expect(html).toContain("搜索用户记忆");
  });
});
