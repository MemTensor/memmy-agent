import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

async function withServer<T>(run: (post: (body: unknown) => Promise<Response>, repos: Repositories) => Promise<T>): Promise<T> {
  const { service, db } = createTestService();
  const server = createMemoryHttpServer({
    service,
    startAgentSourceAutomation: false,
    auth: { mode: "local", allowAnonymous: true }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/l3/user-projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    return await run(post, new Repositories(db.db));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const envelope = () => ({
  requestId: randomUUID(),
  adapterId: "memmy-agent",
  source: "memmy-agent",
  namespace: { source: "memmy-agent", profileId: "default", userId: "desk-user" }
});

describe("L3 user projects endpoint", () => {
  it("replaces the whole list and the standalone roots for the user", async () => {
    await withServer(async (post, repos) => {
      const first = await post({ ...envelope(), projects: [
        { rootPath: "/work/a", name: "A" }, { rootPath: "/work/b", name: "B" }
      ], standaloneRoots: ["/Users/me/Memmy"] });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ count: 2 });
      const second = await post({ ...envelope(), projects: [{ rootPath: "/work/b", name: "B2" }] });
      expect(second.status).toBe(200);
      expect(repos.l3Field.listUserProjects("desk-user")).toEqual([{ rootPath: "/work/b", name: "B2" }]);
      expect(repos.l3Field.getStandaloneRoots("desk-user")).toEqual([]);
    });
  });

  it("rejects relative project paths", async () => {
    await withServer(async (post, repos) => {
      const response = await post({ ...envelope(), projects: [{ rootPath: "work/a", name: "A" }] });
      expect(response.status).toBe(400);
      expect(repos.l3Field.listUserProjects("desk-user")).toEqual([]);
    });
  });
});

describe("L3 user projects contract copies", () => {
  it("keeps the Memory and App contract files identical", () => {
    const memoryCopy = fileURLToPath(new URL("../../src/contracts/memory-l3-world-model.ts", import.meta.url));
    const appCopy = fileURLToPath(new URL("../../../App/backend/local-api-contracts/src/memory-l3-world-model.ts", import.meta.url));
    expect(readFileSync(appCopy, "utf8")).toBe(readFileSync(memoryCopy, "utf8"));
  });
});
