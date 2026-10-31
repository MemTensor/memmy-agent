import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from "fastify";
import { registerHealthRoute } from "../adapters/inbound/local-api/routes/agent-runtime/health.js";
import type { AgentRuntimeRouteDeps } from "../adapters/inbound/local-api/routes/agent-runtime/index.js";
import { createHttpMemoryClient } from "../adapters/outbound/memory-client/http-memory-client.js";

describe("health request cancellation", () => {
  it.each(["aborted", "close"])("releases downstream health on %s without retrying", async event => {
    let handler!: RouteHandlerMethod;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    let downstream: AbortSignal | undefined;
    const memoryClient = createHttpMemoryClient({baseUrl:"http://synthetic.invalid",token:"synthetic",timeoutMs:1000,maxRetries:3}, {
      fetchImpl: (async (_url, init) => {
        calls++; downstream = init!.signal!;
        started();
        return new Promise<Response>((_resolve, reject) => downstream!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {once:true}));
      }) as typeof fetch
    });
    registerHealthRoute({get: (_path: string, _options: unknown, next: RouteHandlerMethod) => { handler=next; }} as FastifyInstance,
      {services:{memoryClient},timeZone:"+08:00"} as AgentRuntimeRouteDeps);
    const request = {raw:new EventEmitter(),headers:{}} as unknown as FastifyRequest;
    let body: unknown;
    const reply = {raw:new EventEmitter(),code(){return this;},send(value:unknown){body=value;return this;}} as unknown as FastifyReply;
    const done = handler.call({} as FastifyInstance, request, reply);
    await ready;
    (event === "aborted" ? request.raw : reply.raw).emit(event);
    await done;
    expect(downstream?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(body).toMatchObject({error:{message:"memory layer request cancelled"}});
  });
});
