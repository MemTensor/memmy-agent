/**
 * 工作区路径的显示写法：侧栏与项目设置看到同一个项目时不能出现两种写法。
 * 只改展示，不解析路径本身——末尾斜杠、符号链接这些交给比较用的 `sameWorkspacePath`。
 */
import { describe, expect, it } from "vitest";
import { formatWorkspacePath } from "../workspace-path.js";

describe("formatWorkspacePath", () => {
  it("把用户主目录缩成 ~", () => {
    expect(formatWorkspacePath("/Users/a/x")).toBe("~/x");
    expect(formatWorkspacePath("/home/a/x")).toBe("~/x");
  });

  it("Windows 的反斜杠换成正斜杠", () => {
    expect(formatWorkspacePath("C:\\Users\\a\\x")).toBe("C:/Users/a/x");
  });

  it("其他路径原样返回", () => {
    expect(formatWorkspacePath("/tmp/memmy")).toBe("/tmp/memmy");
    // 只有恰好位于主目录下一层的才缩写：/Users 本身不是任何人的家目录。
    expect(formatWorkspacePath("/Users")).toBe("/Users");
  });
});
