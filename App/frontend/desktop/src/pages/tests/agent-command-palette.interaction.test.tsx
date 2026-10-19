// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentCommandPalette, defaultSlashCommandIndex, filterSlashCommands } from "../agent-command-palette.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("scrolls to and selects commands beyond the initial visible rows", () => {
  const names = ["/new", "/restart", "/status", "/model", "/history", "/history-dag", "/goal", "/help", "/pairing"];
  const commands = filterSlashCommands(names.map((command) => ({
    command, title: command, description: "", icon: "activity", argHint: ""
  })), "", []);
  const scrollIntoView = vi.fn();
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  try {
    act(() => root.render(<AgentCommandPalette commands={commands} heading="Commands" selectedIndex={0} onSelect={onSelect} />));
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(commands.length);
    scrollIntoView.mockClear();
    act(() => root.render(<AgentCommandPalette commands={commands} heading="Commands" selectedIndex={8} onSelect={onSelect} />));
    const selected = container.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
    expect(selected.textContent).toContain("/pairing");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(selected);
    act(() => selected.click());
    expect(onSelect).toHaveBeenCalledWith(commands[8]);

    const goalMatches = filterSlashCommands(commands.filter((command) => !command.command.includes(" ")), "g", []);
    scrollIntoView.mockClear();
    act(() => root.render(<AgentCommandPalette commands={goalMatches} heading="Commands" selectedIndex={defaultSlashCommandIndex("g", goalMatches.length)} onSelect={onSelect} />));
    const goalOptions = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
    const closest = goalOptions[goalOptions.length - 1]!;
    expect(goalOptions).toHaveLength(10);
    expect(closest.getAttribute("aria-selected")).toBe("true");
    expect(closest.querySelector(".font-mono")?.textContent).toBe("/goal");
    expect(scrollIntoView.mock.contexts[0]).toBe(closest);
    expect(container.textContent).toContain("/goal pause");
    expect(container.textContent).toContain("/goal budget none");
    act(() => closest.click());
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ command: "/goal" }));
  } finally {
    act(() => root.unmount());
    container.remove();
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});
