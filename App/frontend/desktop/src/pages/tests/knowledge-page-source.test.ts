import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = fileURLToPath(new URL("../knowledge-page.tsx", import.meta.url));

describe("KnowledgePage integration contract", () => {
  it("mounts the knowledge workspace inside AppFrame with the active account and runtime clients", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('<AppFrame title={t("nav.knowledge")}>');
    expect(source).toContain('className="h-full overflow-y-auto"');
    expect(source).toContain("{clients && (");
    expect(source).toContain('key={state.account.userId ?? "signed-out"}');
    expect(source).toContain("connection={clients.runtimeConfig}");
    expect(source).toContain("language={language}");
  });

  it("routes sign-in from the knowledge workspace back to welcome", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('onSignIn={() => dispatch(appActions.navigate("/welcome"))}');
  });
});
