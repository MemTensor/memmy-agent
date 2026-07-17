import { describe, expect, it } from "vitest";
import { RequestContext } from "../../src/core/agent-runtime/tools/context.js";
import { CronTool } from "../../src/core/agent-runtime/tools/cron.js";
import { ToolRegistry } from "../../src/core/agent-runtime/tools/registry.js";

class ServiceStub {
  listJobs() {
    return [];
  }

  getJob(jobId: string) {
    void jobId;
    return null;
  }

  removeJob(jobId: string) {
    void jobId;
    return "not-found";
  }

  addJob(kwargs: any) {
    return { id: "id1", name: kwargs.name ?? "x" };
  }
}

function registry(): ToolRegistry {
  const tool = new CronTool(new ServiceStub() as any, "UTC");
  tool.setContext(new RequestContext({ channel: "channel", chatId: "chat-id" }));
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg;
}

describe("CronTool schema contract", () => {
  it("accepts list without message", () => {
    const [, , err] = registry().prepareCall("cron", { action: "list" });

    expect(err).toBeNull();
  });

  it("accepts remove without message", () => {
    const [, , err] = registry().prepareCall("cron", { action: "remove", job_id: "abc" });

    expect(err).toBeNull();
  });

  it("accepts add when message is provided", () => {
    const [, , err] = registry().prepareCall("cron", { action: "add", message: "ping", at: "2030-01-01T00:00:00" });

    expect(err).toBeNull();
  });

  it("returns an actionable runtime error for add without message", async () => {
    const tool = registry().get("cron") as CronTool;

    const out = await tool.execute({ action: "add", at: "2030-01-01T00:00:00" });

    expect(out).toContain("message");
    expect(out).toContain("add");
    expect(out.toLowerCase()).toContain("retry");
  });

  it("message description flags the add requirement", () => {
    const tool = new CronTool(new ServiceStub() as any);

    expect(tool.parameters.properties.message.description).toContain("REQUIRED");
    expect(tool.parameters.properties.message.description).toContain("action='add'");
  });

  it("job_id description flags the remove requirement", () => {
    const tool = new CronTool(new ServiceStub() as any);

    expect(tool.parameters.properties.job_id.description).toContain("REQUIRED");
    expect(tool.parameters.properties.job_id.description).toContain("action='remove'");
  });

  it("keeps top-level required fields narrow", () => {
    const tool = new CronTool(new ServiceStub() as any);

    expect(tool.parameters.required).toEqual(["action"]);
  });

  it("does not use unsupported schema combinators", () => {
    const tool = new CronTool(new ServiceStub() as any);

    for (const disallowed of ["oneOf", "anyOf", "allOf", "not"]) expect(tool.parameters).not.toHaveProperty(disallowed);
  });
});
