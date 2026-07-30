import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ImprovementProgramModal } from "../improvement-program-modal.js";

describe("ImprovementProgramModal", () => {
  it("renders the configured regional reward instead of a hard-coded amount", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ImprovementProgramModal
          giftTokens={300_000}
          showGift
          onChoice={vi.fn()}
          onLearnMore={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("300,000 Token");
    expect(html).not.toContain("5,000,000 Token");
  });
});
