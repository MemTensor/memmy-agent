import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { SocialLoginButtons } from "../social-login-buttons.js";

describe("SocialLoginButtons", () => {
  it("renders Google and GitHub sign-in choices", () => {
    const onLogin = vi.fn();
    const html = renderToString(
      <I18nProvider language="en-US">
        <SocialLoginButtons pendingProvider={null} onLogin={onLogin} />
      </I18nProvider>
    );

    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(onLogin).not.toHaveBeenCalled();
  });
});
