import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Tool, type ToolExecutionContext } from "../../core/agent-runtime/tools/base.js";
import { storeToolImageArtifact } from "../../utils/artifacts.js";

const execFileAsync = promisify(execFile);

// Native macOS input helper. Compiled on demand with the system `swiftc` and
// cached under ~/.memmy/tools/computer-use, keyed by a hash of this source.
const INPUT_HELPER_SOURCE = String.raw`import Foundation
import CoreGraphics
import ApplicationServices

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("error: " + message + "\n").data(using: .utf8)!)
  exit(1)
}

func num(_ raw: String, _ label: String) -> Double {
  guard let value = Double(raw), value.isFinite else { fail("invalid \(label): \(raw)") }
  return value
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
  "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "` + "`" + String.raw`": 50,
  "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
]

let modifierFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand,
  "shift": .maskShift,
  "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
  "ctrl": .maskControl, "control": .maskControl,
  "fn": .maskSecondaryFn,
]

func moveCursor(_ point: CGPoint) {
  guard let event = CGEvent(
    mouseEventSource: nil, mouseType: .mouseMoved,
    mouseCursorPosition: point, mouseButton: .left
  ) else { fail("cannot create mouse move event") }
  event.post(tap: .cghidEventTap)
}

func postClick(_ point: CGPoint, button: String, clickState: Int64) {
  let isRight = button == "right"
  let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
  let cgButton: CGMouseButton = isRight ? .right : .left
  for type in [downType, upType] {
    guard let event = CGEvent(
      mouseEventSource: nil, mouseType: type,
      mouseCursorPosition: point, mouseButton: cgButton
    ) else { fail("cannot create mouse event") }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
    usleep(30_000)
  }
}

func click(_ point: CGPoint, button: String) {
  moveCursor(point)
  usleep(60_000)
  if button == "double" {
    postClick(point, button: "left", clickState: 1)
    usleep(80_000)
    postClick(point, button: "left", clickState: 2)
  } else {
    postClick(point, button: button, clickState: 1)
  }
}

func pressKeyCombo(_ combo: String) {
  let parts = combo.lowercased().split(separator: "+").map(String.init)
  guard let keyName = parts.last else { fail("empty key combo") }
  var flags: CGEventFlags = []
  for part in parts.dropLast() {
    guard let flag = modifierFlags[part] else { fail("unknown modifier: \(part)") }
    flags.insert(flag)
  }
  guard let code = keyCodes[keyName] else { fail("unknown key: \(keyName)") }
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
  else { fail("cannot create key event") }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  usleep(30_000)
  up.post(tap: .cghidEventTap)
}

func typeChunk(_ chunk: [UInt16]) {
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
  else { fail("cannot create keyboard event") }
  chunk.withUnsafeBufferPointer { buffer in
    down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
    up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
  }
  down.post(tap: .cghidEventTap)
  usleep(15_000)
  up.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
  let lines = text.components(separatedBy: "\n")
  for (index, line) in lines.enumerated() {
    if index > 0 {
      usleep(40_000)
      pressKeyCombo("return")
      usleep(40_000)
    }
    let units = Array(line.utf16)
    var offset = 0
    while offset < units.count {
      let end = min(offset + 20, units.count)
      typeChunk(Array(units[offset..<end]))
      usleep(25_000)
      offset = end
    }
  }
}

func scroll(_ point: CGPoint, dx: Int32, dy: Int32) {
  moveCursor(point)
  usleep(40_000)
  guard let event = CGEvent(
    scrollWheelEvent2Source: nil, units: .pixel,
    wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0
  ) else { fail("cannot create scroll event") }
  event.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: computer-input <info|move|click|scroll|type|key> ...") }

switch args[1] {
case "info":
  let bounds = CGDisplayBounds(CGMainDisplayID())
  let trusted = AXIsProcessTrusted()
  let screenCapture = CGPreflightScreenCaptureAccess()
  print(
    "{\"width\":\(Int(bounds.width)),\"height\":\(Int(bounds.height)),"
    + "\"accessibility\":\(trusted),\"screenRecording\":\(screenCapture)}"
  )
case "move":
  guard args.count >= 4 else { fail("usage: move <x> <y>") }
  moveCursor(CGPoint(x: num(args[2], "x"), y: num(args[3], "y")))
case "click":
  guard args.count >= 4 else { fail("usage: click <x> <y> [left|right|double]") }
  let button = args.count >= 5 ? args[4] : "left"
  guard ["left", "right", "double"].contains(button) else { fail("unknown button: \(button)") }
  click(CGPoint(x: num(args[2], "x"), y: num(args[3], "y")), button: button)
case "scroll":
  guard args.count >= 6 else { fail("usage: scroll <x> <y> <dx> <dy>") }
  scroll(
    CGPoint(x: num(args[2], "x"), y: num(args[3], "y")),
    dx: Int32(num(args[4], "dx")), dy: Int32(num(args[5], "dy"))
  )
case "type":
  guard args.count >= 3 else { fail("usage: type <text>") }
  typeText(args[2])
case "key":
  guard args.count >= 3 else { fail("usage: key <combo>") }
  pressKeyCombo(args[2])
default:
  fail("unknown command: \(args[1])")
}
`;

type ScreenInfo = {
  width: number;
  height: number;
  accessibility: boolean;
  screenRecording: boolean;
};

const ACTION_SETTLE_MS = 600;
const SCREENSHOT_JPEG_QUALITY = "80";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DIRECT_PHYSICAL_KEYS = new Set([
  "=", "-", "]", "[", "'", ";", "\\", ",", "/", ".", "`",
]);

const SHIFTED_PHYSICAL_KEYS = new Map<string, string>([
  ["!", "shift+1"],
  ["@", "shift+2"],
  ["#", "shift+3"],
  ["$", "shift+4"],
  ["%", "shift+5"],
  ["^", "shift+6"],
  ["&", "shift+7"],
  ["*", "shift+8"],
  ["(", "shift+9"],
  [")", "shift+0"],
  ["_", "shift+-"],
  ["+", "shift+="],
  ["{", "shift+["],
  ["}", "shift+]"],
  ["|", "shift+\\"],
  [":", "shift+;"],
  ["\"", "shift+'"],
  ["<", "shift+,"],
  [">", "shift+."],
  ["?", "shift+/"],
  ["~", "shift+`"],
]);

/**
 * Return a computer_key-compatible combo for characters that macOS system
 * fields handle more reliably as physical key events than Unicode injection.
 */
export function physicalKeyComboForCharacter(character: string): string | null {
  if (character === "\n" || character === "\r") return "return";
  if (character === "\t") return "tab";
  if (character === " ") return "space";
  if (/^[A-Z]$/.test(character)) return `shift+${character.toLowerCase()}`;
  const shifted = SHIFTED_PHYSICAL_KEYS.get(character);
  if (shifted) return shifted;
  if (/^[a-z0-9]$/.test(character) || DIRECT_PHYSICAL_KEYS.has(character)) return character;
  return null;
}

export class ComputerController {
  private helperPromise: Promise<string> | null = null;

  private helperDir(): string {
    return path.join(os.homedir(), ".memmy", "tools", "computer-use");
  }

  private async ensureHelper(): Promise<string> {
    this.helperPromise ??= this.buildHelper().catch((error) => {
      this.helperPromise = null;
      throw error;
    });
    return this.helperPromise;
  }

  private async buildHelper(): Promise<string> {
    const hash = crypto.createHash("sha256").update(INPUT_HELPER_SOURCE).digest("hex").slice(0, 12);
    const dir = this.helperDir();
    const binary = path.join(dir, `computer-input-${hash}`);
    if (fs.existsSync(binary)) return binary;
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, `computer-input-${hash}.swift`);
    fs.writeFileSync(source, INPUT_HELPER_SOURCE, "utf8");
    try {
      await execFileAsync("swiftc", ["-O", "-o", binary, source], { timeout: 120_000 });
    } catch (error) {
      throw new Error(
        `failed to compile computer-use input helper (requires Xcode Command Line Tools): ${(error as Error).message}`,
      );
    }
    return binary;
  }

  private async runHelper(args: string[]): Promise<string> {
    const binary = await this.ensureHelper();
    const { stdout } = await execFileAsync(binary, args, { timeout: 60_000 });
    return stdout.trim();
  }

  async screenInfo(): Promise<ScreenInfo> {
    const raw = await this.runHelper(["info"]);
    return JSON.parse(raw) as ScreenInfo;
  }

  permissionWarnings(info: ScreenInfo): string[] {
    const warnings: string[] = [];
    if (!info.screenRecording) {
      warnings.push(
        "Screen Recording permission is NOT granted to the app hosting memmy; screenshots may only show the wallpaper. Grant it in System Settings > Privacy & Security > Screen Recording, then restart memmy.",
      );
    }
    if (!info.accessibility) {
      warnings.push(
        "Accessibility permission is NOT granted to the app hosting memmy; clicks and keystrokes will be ignored by macOS. Grant it in System Settings > Privacy & Security > Accessibility, then restart memmy.",
      );
    }
    return warnings;
  }

  async screenshot(): Promise<Array<Record<string, any>>> {
    const info = await this.screenInfo();
    const file = path.join(
      os.tmpdir(),
      `memmy-computer-${crypto.randomUUID().replace(/-/g, "")}.jpg`,
    );
    try {
      await execFileAsync("screencapture", ["-x", "-C", "-t", "jpg", file], { timeout: 30_000 });
      // Capture happens at physical pixels; resample to point resolution so the
      // coordinates the model reads off the image match the input coordinate space.
      await execFileAsync(
        "sips",
        [
          "--resampleWidth", String(info.width),
          "-s", "formatOptions", SCREENSHOT_JPEG_QUALITY,
          file,
        ],
        { timeout: 30_000 },
      );
      const data = fs.readFileSync(file).toString("base64");
      const stored = storeToolImageArtifact(data, "image/jpeg");
      const lines = [
        `Screenshot of the main display (${info.width}x${info.height} points). Coordinates in the image map 1:1 to click coordinates.`,
        `Saved to: ${stored.path}`,
        ...this.permissionWarnings(info),
      ];
      return [
        { type: "text", text: lines.join("\n") },
        { type: "image_url", image_url: { url: stored.dataUrl, detail: "auto" }, meta: { path: stored.path } },
      ];
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  private async actionResult(
    summary: string,
    screenshotAfter: boolean,
  ): Promise<string | Array<Record<string, any>>> {
    if (!screenshotAfter) {
      const info = await this.screenInfo();
      return [summary, ...this.permissionWarnings(info)].join("\n");
    }
    await delay(ACTION_SETTLE_MS);
    // Permission warnings are already included in the screenshot's text block.
    const blocks = await this.screenshot();
    return [{ type: "text", text: summary }, ...blocks];
  }

  async click(
    x: number,
    y: number,
    button: string,
    screenshotAfter: boolean,
  ): Promise<string | Array<Record<string, any>>> {
    await this.runHelper(["click", String(x), String(y), button]);
    return this.actionResult(`Performed ${button} click at (${x}, ${y}).`, screenshotAfter);
  }

  async typeText(
    text: string,
    screenshotAfter: boolean,
  ): Promise<string | Array<Record<string, any>>> {
    let unicodeBuffer = "";
    const flushUnicode = async (): Promise<void> => {
      if (unicodeBuffer.length === 0) return;
      await this.runHelper(["type", unicodeBuffer]);
      unicodeBuffer = "";
    };

    for (const character of text) {
      const combo = physicalKeyComboForCharacter(character);
      if (combo === null) {
        unicodeBuffer += character;
        continue;
      }
      await flushUnicode();
      await this.runHelper(["key", combo]);
    }
    await flushUnicode();
    return this.actionResult(`Typed ${text.length} characters.`, screenshotAfter);
  }

  async pressKey(
    combo: string,
    screenshotAfter: boolean,
  ): Promise<string | Array<Record<string, any>>> {
    await this.runHelper(["key", combo]);
    return this.actionResult(`Pressed keys: ${combo}.`, screenshotAfter);
  }

  async scroll(
    x: number,
    y: number,
    direction: string,
    amount: number,
    screenshotAfter: boolean,
  ): Promise<string | Array<Record<string, any>>> {
    let dx = 0;
    let dy = 0;
    if (direction === "up") dy = amount;
    else if (direction === "down") dy = -amount;
    else if (direction === "left") dx = amount;
    else if (direction === "right") dx = -amount;
    await this.runHelper(["scroll", String(x), String(y), String(dx), String(dy)]);
    return this.actionResult(`Scrolled ${direction} by ${amount}px at (${x}, ${y}).`, screenshotAfter);
  }
}

const sharedController = new ComputerController();

function computerUseEnabled(): boolean {
  return process.platform === "darwin" && process.env.MEMMY_COMPUTER_USE !== "0";
}

const SCREENSHOT_AFTER_PARAM = {
  type: "boolean",
  description: "Take a screenshot after the action and include it in the result (default true).",
};

abstract class ComputerTool extends Tool {
  static scopes = new Set(["core"]);
  protected readonly controller = sharedController;

  static enabled(_ctx: any): boolean {
    return computerUseEnabled();
  }
}

export class ComputerScreenshotTool extends ComputerTool {
  get name(): string {
    return "computer_screenshot";
  }

  get description(): string {
    return "Take a screenshot of the primary macOS display to see the current desktop state. The returned image is in screen points: coordinates read from it can be passed directly to computer_click / computer_scroll. Use this before and after desktop interactions to verify state.";
  }

  get parameters(): Record<string, any> {
    return { type: "object", properties: {}, required: [] };
  }

  override get readOnly(): boolean {
    return true;
  }

  async execute(): Promise<Array<Record<string, any>>> {
    return this.controller.screenshot();
  }
}

export class ComputerClickTool extends ComputerTool {
  get name(): string {
    return "computer_click";
  }

  get description(): string {
    return "Click at a screen coordinate on the primary macOS display (desktop apps, not the managed browser). Coordinates are in points as shown by computer_screenshot. Verify the target location from a recent screenshot before clicking.";
  }

  get parameters(): Record<string, any> {
    return {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate in screen points." },
        y: { type: "number", description: "Y coordinate in screen points." },
        button: {
          type: "string",
          enum: ["left", "right", "double"],
          description: "Click type (default left).",
        },
        screenshot_after: SCREENSHOT_AFTER_PARAM,
      },
      required: ["x", "y"],
    };
  }

  async execute(params: Record<string, any> = {}): Promise<string | Array<Record<string, any>>> {
    return this.controller.click(
      Number(params.x),
      Number(params.y),
      typeof params.button === "string" ? params.button : "left",
      params.screenshot_after !== false,
    );
  }
}

export class ComputerTypeTool extends ComputerTool {
  get name(): string {
    return "computer_type";
  }

  get description(): string {
    return "Type text into the currently focused desktop element (supports any unicode text, including CJK). Click the target field first even if a caret is already visible, then verify the typed text in the returned screenshot. ASCII uses physical key events for compatibility with macOS system fields; newlines are sent as Return key presses.";
  }

  get parameters(): Record<string, any> {
    return {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type." },
        screenshot_after: SCREENSHOT_AFTER_PARAM,
      },
      required: ["text"],
    };
  }

  async execute(params: Record<string, any> = {}): Promise<string | Array<Record<string, any>>> {
    return this.controller.typeText(String(params.text ?? ""), params.screenshot_after !== false);
  }
}

export class ComputerKeyTool extends ComputerTool {
  get name(): string {
    return "computer_key";
  }

  get description(): string {
    return "Press a key or key combination on the desktop, e.g. 'return', 'escape', 'tab', 'cmd+t', 'cmd+shift+4', 'ctrl+left'. Modifiers: cmd, shift, alt/option, ctrl, fn.";
  }

  get parameters(): Record<string, any> {
    return {
      type: "object",
      properties: {
        keys: { type: "string", description: "Key combo such as 'cmd+t' or 'return'." },
        screenshot_after: SCREENSHOT_AFTER_PARAM,
      },
      required: ["keys"],
    };
  }

  async execute(params: Record<string, any> = {}): Promise<string | Array<Record<string, any>>> {
    return this.controller.pressKey(String(params.keys ?? ""), params.screenshot_after !== false);
  }
}

export class ComputerScrollTool extends ComputerTool {
  get name(): string {
    return "computer_scroll";
  }

  get description(): string {
    return "Scroll at a screen coordinate on the primary macOS display. Moves the cursor to (x, y) first, then scrolls in the given direction.";
  }

  get parameters(): Record<string, any> {
    return {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate in screen points." },
        y: { type: "number", description: "Y coordinate in screen points." },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        amount: {
          type: "number",
          description: "Scroll distance in pixels (default 400).",
        },
        screenshot_after: SCREENSHOT_AFTER_PARAM,
      },
      required: ["x", "y", "direction"],
    };
  }

  async execute(params: Record<string, any> = {}): Promise<string | Array<Record<string, any>>> {
    const amount = Number.isFinite(Number(params.amount)) && Number(params.amount) > 0
      ? Number(params.amount)
      : 400;
    return this.controller.scroll(
      Number(params.x),
      Number(params.y),
      String(params.direction ?? "down"),
      amount,
      params.screenshot_after !== false,
    );
  }
}

export const COMPUTER_TOOL_CLASSES = [
  ComputerScreenshotTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerScrollTool,
];
