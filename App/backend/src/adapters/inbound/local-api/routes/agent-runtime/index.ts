/** Agent runtime module. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BackendServices } from "../../../../../services/index.js";
import { registerAdminRoutes } from "./admin.js";
import { registerHealthRoute } from "./health.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerPanelRoutes } from "./panel.js";
import { registerSearchRoute } from "./search.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerTurnRoutes } from "./turns.js";

export interface AgentRuntimeRouteDeps {
  services: BackendServices;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export function registerAgentRuntimeRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  registerAdminRoutes(app, deps);
  registerHealthRoute(app, deps);
  registerSessionRoutes(app, deps);
  registerTurnRoutes(app, deps);
  registerSearchRoute(app, deps);
  registerMemoryRoutes(app, deps);
  registerPanelRoutes(app, deps);
}
