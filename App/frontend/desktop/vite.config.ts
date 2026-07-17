/** Vite configuration. */
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

const DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL = "http://127.0.0.1:18980";
const RUNTIME_CONFIG_ENDPOINT = "/__memmy_runtime_config";
const LOCAL_API_CONTRACTS_SOURCE = fileURLToPath(new URL("../../backend/local-api-contracts/src/index.ts", import.meta.url));
const LEGAL_BASE_URL_ENV_KEYS = ["MEMMY_LEGAL_CN_BASE_URL", "MEMMY_LEGAL_INTL_BASE_URL"] as const;
// Definition for repo root dir.
const REPO_ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** Validates legal website configuration before Vite starts. */
export const validateLegalEnv = (env: Record<string, string | undefined>): void => {
  for (const key of LEGAL_BASE_URL_ENV_KEYS) {
    try {
      const url = new URL(env[key]?.trim() ?? "");
      if (url.protocol !== "https:" || url.href !== `${url.origin}/`) {
        throw new Error();
      }
    } catch {
      throw new Error(`${key} must be an HTTPS origin without a path.`);
    }
  }
};

/** Vite configuration. */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, REPO_ROOT_DIR, "");
  validateLegalEnv(env);
  const memmyAgentTarget = env.VITE_MEMMY_AGENT_WEBUI_URL?.trim() || DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL;
  const memmyAgentWsTarget = memmyAgentTarget.replace(/^http/, "ws");

  return {
    // Base.
    base: "./",
    // Env dir.
    envDir: REPO_ROOT_DIR,
    envPrefix: ["VITE_", "MEMMY_"],
    plugins: [react(), memmyRuntimeConfigPlugin()],
    resolve: {
      alias: [
        {
          // Find.
          find: "@memmy/local-api-contracts",
          // Replacement.
          replacement: LOCAL_API_CONTRACTS_SOURCE
        }
      ]
    },
    server: {
      host: "127.0.0.1",
      port: 19000,
      strictPort: true,
      hmr: {
        host: "127.0.0.1",
        port: 19001
      },
      proxy: {
        "/webui": { target: memmyAgentTarget, changeOrigin: true },
        "/api/sessions": { target: memmyAgentTarget, changeOrigin: true },
        "/api/webui": { target: memmyAgentTarget, changeOrigin: true },
        "/api/settings": { target: memmyAgentTarget, changeOrigin: true },
        "/api/commands": { target: memmyAgentTarget, changeOrigin: true },
        "/api/media": { target: memmyAgentTarget, changeOrigin: true },
        "/": {
          target: memmyAgentWsTarget,
          ws: true,
          changeOrigin: true,
          bypass: (request) => (request.headers.upgrade === "websocket" ? undefined : request.url)
        }
      }
    }
  };
});

/** Handles memmy runtime config plugin. */
function memmyRuntimeConfigPlugin(): Plugin {
  return {
    name: "memmy-runtime-config-dev",
    configureServer(server) {
      server.middlewares.use(RUNTIME_CONFIG_ENDPOINT, async (_request, response) => {
        response.setHeader("cache-control", "no-store");

        try {
          const content = await readFile(resolveRuntimeConfigPath(), "utf8");
          response.statusCode = 200;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(content);
        } catch {
          response.statusCode = 404;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "runtime_config_unavailable" }));
        }
      });
    }
  };
}

/** Handles resolve runtime config path. */
function resolveRuntimeConfigPath(): string {
  return process.env.MEMMY_RUNTIME_CONFIG_PATH?.trim() || join(homedir(), ".memmy", "runtime.json");
}
