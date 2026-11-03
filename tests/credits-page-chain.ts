/** Launched by CreditServiceMysqlTest against its disposable database and local Spring server. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHttpCloudClient } from "../App/backend/src/adapters/outbound/cloud-client/http-cloud-client.js";
import { createCreditsService } from "../App/backend/src/services/credits-service.js";
import { registerCreditsRoutes } from "../App/backend/src/adapters/inbound/local-api/routes/credits.js";
import { createHttpCreditsClient } from "../App/frontend/desktop/src/api/credits-client.js";
import type { RuntimeConfig } from "@memmy/local-api-contracts";
import type { AccountSessionRepository } from "../App/backend/src/infrastructure/app-state-store/repositories/account-session-repo.js";

assert.ok(process.env.CREDITS_CHAIN_TOKEN, "Run through the isolated Java test; no real account token is accepted here");
const cloud = createHttpCloudClient({ baseUrl: "http://127.0.0.1:18202", timeoutMs: 10000 });
const accounts = { getCloudUuid: () => process.env.CREDITS_CHAIN_TOKEN! } as AccountSessionRepository;
const app = Fastify();
registerCreditsRoutes(app, { credits: createCreditsService(cloud, accounts), authenticateRuntimeToken: async (request, reply) => {
  if (request.headers["x-memmy-local-token"] !== "chain-runtime-test") return reply.code(401).send();
} });
try {
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createHttpCreditsClient({ baseUrl, localToken: "chain-runtime-test", timeZone: "Asia/Shanghai" } as RuntimeConfig);
  assert.equal((await client.summary()).account.balance, "998.49");
  assert.equal((await client.grants()).items[0]?.used, "1.51");
  assert.equal((await client.ledger({ businessType: "MODEL_USAGE" })).items.length, 3);
  const range = { from: "2026-01-31T00:00:00+08:00", to: "2026-02-01T00:00:00+08:00" };
  const agent = await client.usage({ ...range, domain: "agent" });
  assert.deepEqual(agent.items.map(row => [row.callId, row.chargedCredits]), [["test-call-1", "1.01"]]);
  const detail = await client.usageDetail("test-call-1");
  assert.equal(detail.remainingCredits, "998.99");
  assert.equal(detail.settlementStatus, "SETTLED");
  await assert.rejects(client.usageDetail("test-call-3"), { status: 404 });
  const memory = await client.usage({ ...range, domain: "memory" });
  assert.equal(memory.items.length, 1); assert.equal(memory.items[0]?.callCount, 2); assert.equal(memory.items[0]?.chargedCredits, "0.50");
  const exported = await client.usageExport({ ...range, domain: "memory" });
  assert.equal(exported.rowCount, 2);
  const { csv } = await client.usageDownload(exported.downloadUrl);
  assert.ok(csv.includes('"test-call-4"')); assert.ok(csv.includes('"test-call-5"'));
  assert.ok(!csv.includes("pending-model")); assert.ok(!csv.includes("other-account"));
  const unauthorized = await fetch(`${baseUrl}/api/credits/usage`); assert.equal(unauthorized.status, 401);
  console.log("PASS: real frontend client → Fastify → authenticated Spring HTTP → isolated MySQL, including CSV");
} finally { await app.close(); }
