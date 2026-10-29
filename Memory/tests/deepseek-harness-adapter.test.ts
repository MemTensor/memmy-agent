import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Message = {
  role?: string;
  source?: { kind: string; form?: string };
  content: string | Array<{ type: string; text: string }>;
};

type Payload = {
  agent: { id: string; session: { id: string } };
  messages?: Message[];
  message?: Message;
};

type PreStep = (payload: Payload, next: () => unknown) => Promise<unknown>;

describe("standalone DeepSeek Harness adapter", () => {
  it("keeps the user query when a later pre-step contains its injected recall", async () => {
    const { preStep, starts, fetchMock } = await adapterHarness();
    const payload = userPayload([{ role: "user", source: { kind: "user" }, content: "Find the purchase approval" }]);
    const next = vi.fn(() => ({ kind: "accept" }));

    await preStep(payload, next);
    expect(payload.messages?.at(-1)).toMatchObject({ role: "user", source: { kind: "memmy-memory", form: "recall" } });
    await preStep(payload, next);

    expect(starts.map((body) => body.query)).toEqual(["Find the purchase approval", "Find the purchase approval"]);
    expect(next).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sessions/open"))).toHaveLength(1);
  });

  it("keeps role:user fallback for messages without a source", async () => {
    const { preStep, starts } = await adapterHarness();
    await preStep(userPayload([
      { role: "user", content: [{ type: "text", text: "Check the delivery date" }] },
      { role: "user", source: { kind: "memmy-memory", form: "recall" }, content: "Old delivery context" }
    ]), () => undefined);

    expect(starts.map((body) => body.query)).toEqual(["Check the delivery date"]);
  });

  it.each(["memmy-memory", "plugin"])("does not start a turn from a %s packet", async (kind) => {
    const { preStep, starts } = await adapterHarness();
    const message = { role: "user", source: { kind }, content: "Historical context" };
    await preStep({ ...userPayload([message]), message }, () => undefined);

    expect(starts).toEqual([]);
  });

  it("skips an empty user message while finding the latest user query", async () => {
    const { preStep, starts } = await adapterHarness();
    await preStep(userPayload([
      { source: { kind: "user" }, content: "Use the revised deadline" },
      { role: "user", source: { kind: "user" }, content: "   " }
    ]), () => undefined);

    expect(starts.map((body) => body.query)).toEqual(["Use the revised deadline"]);
  });

  it("keeps the legacy payload.message fallback", async () => {
    const { preStep, starts } = await adapterHarness();
    await preStep({ agent: userPayload([]).agent, message: { content: "Summarize this request" } }, () => undefined);

    expect(starts.map((body) => body.query)).toEqual(["Summarize this request"]);
  });
});

function userPayload(messages: Message[]): Payload {
  return { agent: { id: "agent-1", session: { id: "session-1" } }, messages };
}

async function adapterHarness() {
  const starts: Array<{ query: string }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/sessions/open")) return response({ sessionId: "memory-session-1" });
    if (String(url).endsWith("/turns/start")) {
      starts.push(JSON.parse(String(init?.body)));
      return response({ turnId: `memory-turn-${starts.length}`, injectedContext: "Historical recall context" });
    }
    throw new Error(`Unexpected adapter request: ${String(url)}`);
  });
  const schema = { default: () => schema, min: () => schema, max: () => schema };
  const source = readFileSync(resolve(import.meta.dirname, "../adapters/dsh/index.js"), "utf8")
    .replace(/^import .+;\n/gm, "")
    .replace(/^export /gm, "");
  // Execute the shipped adapter with its DSH peer services supplied by the harness.
  const apply = runInNewContext(`${source}\napply;`, {
    Schema: { object: (value: unknown) => value, boolean: () => schema, string: () => schema, number: () => schema },
    defineTool: (value: unknown) => value,
    fetch: fetchMock,
    AbortSignal,
    process: { env: {} }
  }) as (ctx: unknown, config: unknown) => Promise<() => void>;
  let preStep: PreStep | undefined;
  await apply({
    systemPrompt: { section: () => () => undefined },
    logger: { warn: (message: string) => { throw new Error(message); } },
    on: (event: string, callback: PreStep) => {
      if (event === "agent/pre-step") preStep = callback;
      return () => undefined;
    }
  }, { enabled: true, recallEnabled: true, captureEnabled: false, toolsEnabled: false, recallTimeoutMs: 3_000 });
  if (!preStep) throw new Error("Adapter did not register agent/pre-step");
  return { preStep, starts, fetchMock };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
