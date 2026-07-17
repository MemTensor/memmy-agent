import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeartbeatService } from "../../src/heartbeat/service.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../src/providers/base.js";

const roots: string[] = [];

class StubProvider extends LLMProvider {
  constructor(private readonly tasks: string) {
    super();
  }

  async chat(): Promise<LLMResponse> {
    return new LLMResponse({
      content: "",
      toolCalls: [
        new ToolCallRequest({
          id: "hb_1",
          name: "heartbeat",
          arguments: { action: "run", tasks: this.tasks },
        }),
      ],
    });
  }

  getDefaultModel(): string {
    return "test-model";
  }
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-heartbeat-deliverability-"));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, "HEARTBEAT.md"), "- [ ] check inbox", "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("HeartbeatService deliverability filter", () => {
  it("accepts normal reports and short dismissals", () => {
    expect(HeartbeatService.isDeliverable("2 new emails — invoice from Zain, meeting rescheduled to 3pm.")).toBe(true);
    expect(HeartbeatService.isDeliverable("All clear.")).toBe(true);
    expect(HeartbeatService.isDeliverable("")).toBe(true);
  });

  it("blocks finalization fallback text", () => {
    expect(
      HeartbeatService.isDeliverable("I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task."),
    ).toBe(false);
  });

  it("blocks leaked heartbeat and awareness file references", () => {
    expect(HeartbeatService.isDeliverable("Yes — HEARTBEAT.md has active tasks listed.")).toBe(false);
    expect(HeartbeatService.isDeliverable("I reviewed AWARENESS.md and found no new signals.")).toBe(false);
  });

  it("blocks leaked awareness file references", () => {
    expect(HeartbeatService.isDeliverable("I reviewed AWARENESS.md and found no new signals.")).toBe(false);
  });

  it("blocks leaked judgment-call phrasing", () => {
    expect(HeartbeatService.isDeliverable("Best judgment call: stay quiet.")).toBe(false);
  });

  it("blocks leaked decision logic", () => {
    expect(HeartbeatService.isDeliverable("Strict HEARTBEAT interpretation. Decision logic says SHORT UPDATE.")).toBe(false);
  });

  it("blocks leaked valid options", () => {
    expect(HeartbeatService.isDeliverable("The valid options are FULL REPORT, SHORT UPDATE, or SILENT.")).toBe(false);
  });

  it("blocks leaked instruction references", () => {
    expect(HeartbeatService.isDeliverable("My instructions say to check Gmail and Calendar.")).toBe(false);
    expect(HeartbeatService.isDeliverable("I am supposed to scan for urgent emails.")).toBe(false);
  });

  it("blocks leaked supposed-to phrasing", () => {
    expect(HeartbeatService.isDeliverable("I am supposed to scan for urgent emails.")).toBe(false);
  });

  it("blocks heartbeat file references case-insensitively", () => {
    expect(HeartbeatService.isDeliverable("HEARTBEAT.MD has tasks listed.")).toBe(false);
  });

  it("accepts empty strings without crashing", () => {
    expect(HeartbeatService.isDeliverable("")).toBe(true);
  });

  it("blocks leaked internal decision language", () => {
    for (const response of [
      "Best judgment call: stay quiet.",
      "Strict HEARTBEAT interpretation. Decision logic says SHORT UPDATE.",
      "The valid options are FULL REPORT, SHORT UPDATE, or SILENT.",
      "My instructions say to check Gmail and Calendar.",
      "I am supposed to scan for urgent emails.",
      "HEARTBEAT.MD has tasks listed.",
    ]) {
      expect(HeartbeatService.isDeliverable(response)).toBe(false);
    }
  });

  it("suppresses non-deliverable execution output before evaluator and notify", async () => {
    const notified: string[] = [];
    let evaluatorCalled = false;
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: new StubProvider("check inbox"),
      model: "test-model",
      onExecute: async () => "I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.",
      onNotify: async (response) => {
        notified.push(response);
      },
      evaluateResponse: async () => {
        evaluatorCalled = true;
        return true;
      },
    });

    await service.tick();

    expect(notified).toEqual([]);
    expect(evaluatorCalled).toBe(false);
  });

  it("suppresses leaked reasoning before notify", async () => {
    const notified: string[] = [];
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: new StubProvider("check status"),
      model: "test-model",
      onExecute: async () => "HEARTBEAT.md has active tasks listed. They are: Check Gmail.",
      onNotify: async (response) => {
        notified.push(response);
      },
      evaluateResponse: async () => true,
    });

    await service.tick();

    expect(notified).toEqual([]);
  });

  it("delivers normal reports when the evaluator approves", async () => {
    const notified: string[] = [];
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: new StubProvider("check inbox"),
      model: "test-model",
      onExecute: async () => "3 new emails — client proposal from Zain, invoice, meeting reminder.",
      onNotify: async (response) => {
        notified.push(response);
      },
      evaluateResponse: async () => true,
    });

    await service.tick();

    expect(notified).toEqual(["3 new emails — client proposal from Zain, invoice, meeting reminder."]);
  });
});
