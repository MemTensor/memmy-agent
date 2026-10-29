/** Pet idle animation tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PetIdleAnimation } from "../mascot/pet-idle/pet-idle-animation.js";

describe("PetIdleAnimation", () => {
  it("renders a decorative canvas at the requested size", () => {
    const html = renderToString(<PetIdleAnimation size={120} playing />);

    expect(html).toContain("<canvas");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:120px");
    expect(html).toContain("height:120px");
  });
});
