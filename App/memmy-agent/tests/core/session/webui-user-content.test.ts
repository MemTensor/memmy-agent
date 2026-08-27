import { describe, expect, it } from "vitest";
import {
  goalObjectiveFromCommand,
  visibleWebuiUserContent,
  webuiTitleUserText,
} from "../../../src/core/session/webui-user-content.js";

describe("WebUI user content", () => {
  it("extracts objectives only from Goal creation commands", () => {
    expect(goalObjectiveFromCommand("/goal 编写亚洲流行文化网页")).toBe("编写亚洲流行文化网页");
    expect(goalObjectiveFromCommand("/GOAL 编写亚洲流行文化网页")).toBe("编写亚洲流行文化网页");
    expect(goalObjectiveFromCommand(" /goal create 编写亚洲流行文化网页 ")).toBe("编写亚洲流行文化网页");
    expect(goalObjectiveFromCommand("/goal create pause migration")).toBe("pause migration");
    expect(goalObjectiveFromCommand("/goal status")).toBeNull();
    expect(goalObjectiveFromCommand("/goal pause unexpected")).toBeNull();
    expect(goalObjectiveFromCommand("/goal")).toBeNull();
    expect(goalObjectiveFromCommand("/help")).toBeNull();
  });

  it("keeps control commands intact while hiding the Goal creation wrapper", () => {
    expect(visibleWebuiUserContent("/goal 编写网页")).toBe("编写网页");
    expect(visibleWebuiUserContent("/goal status")).toBe("/goal status");
    expect(visibleWebuiUserContent("普通问题")).toBe("普通问题");
  });

  it("admits Goal objectives but excludes other commands from title input", () => {
    expect(webuiTitleUserText({ role: "user", content: "/goal 编写网页", commandMessage: true })).toBe("编写网页");
    expect(webuiTitleUserText({ role: "user", content: "/status", commandMessage: true })).toBeNull();
    expect(webuiTitleUserText({ role: "user", content: "普通问题" })).toBe("普通问题");
    expect(webuiTitleUserText({ role: "user", content: "继续执行", internal_context: "goal_continuation" })).toBeNull();
  });
});
