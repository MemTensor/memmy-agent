import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ManagedKnowledgeClient,
  parseSettings,
  type ManagedKnowledgeOptions,
} from "./client.js";
import { describeKnowledgeRouteError, knowledgeLog } from "./log.js";
import { KnowledgeError, MAX_UPLOAD_REQUEST_BYTES, record, text } from "./types.js";

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: ManagedKnowledgeOptions & {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
  },
): void {
  const client = new ManagedKnowledgeClient(options);
  app.register(
    async (scoped) => {
      scoped.addContentTypeParser(
        /^multipart\/form-data/,
        { parseAs: "buffer", bodyLimit: MAX_UPLOAD_REQUEST_BYTES },
        (_request, body, done) => {
          done(null, body);
        },
      );
      scoped.addHook("preHandler", options.authenticate);
      scoped.addHook("onSend", async (_request, reply, payload) => {
        reply.header("Cache-Control", "no-store");
        return payload;
      });
      scoped.setErrorHandler((error, request, reply) => {
        const described = describeKnowledgeRouteError(error);
        if (described.kind !== "knowledge")
          knowledgeLog({
            hop: "local-route",
            action: "error",
            kind: described.kind,
            method: request.method,
            path: request.url,
            status: described.status,
            message: described.message,
          });
        void reply
          .code(
            described.status >= 400 && described.status <= 599
              ? described.status
              : 500,
          )
          .send({ error: described.message });
      });
      scoped.get("/settings", () => client.settings());
      scoped.put("/settings", async (request) => {
        const body = record(request.body);
        if (
          Object.keys(body).some(
            (key) => !["enabled", "selectedIds"].includes(key),
          )
        )
          throw new KnowledgeError("仅支持修改召回开关和知识库范围");
        return parseSettings(await client.request("/settings", "PUT", body));
      });
      scoped.post("/bases", async (request) => {
        const body = record(request.body);
        if (Object.keys(body).some((key) => key !== "name"))
          throw new KnowledgeError("仅支持创建当前账户的知识库");
        return parseSettings(await client.request("/bases", "POST", body));
      });
      scoped.patch<{ Params: { id: string } }>("/bases/:id", async (request) => {
        const body = record(request.body);
        if (
          Object.keys(body).some((key) => key !== "name") ||
          !text(body.name).trim() ||
          text(body.name).trim().length > 200
        )
          throw new KnowledgeError("知识库名称无效");
        return parseSettings(
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}`,
            "PATCH",
            { name: text(body.name).trim() },
          ),
        );
      });
      scoped.delete<{ Params: { id: string } }>("/bases/:id", async (request) =>
        parseSettings(
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}`,
            "DELETE",
          ),
        ),
      );
      scoped.get<{ Params: { id: string } }>("/bases/:id/members", async (request) => {
        const data = record(await client.request(`/bases/${encodeURIComponent(request.params.id)}/members`));
        return { members: Array.isArray(data.members) ? data.members : [] };
      });
      scoped.post<{ Params: { id: string } }>("/bases/:id/members", async (request) => {
        const body = record(request.body);
        if (Object.keys(body).some((key) => key !== "userId") || !text(body.userId).trim()) throw new KnowledgeError("用户 ID 无效");
        return client.request(`/bases/${encodeURIComponent(request.params.id)}/members`, "POST", { userId: text(body.userId).trim() });
      });
      scoped.delete<{ Params: { id: string; memberId: string } }>("/bases/:id/members/:memberId", async (request) => {
        await client.request(`/bases/${encodeURIComponent(request.params.id)}/members/${encodeURIComponent(request.params.memberId)}`, "DELETE");
        return { ok: true };
      });
      scoped.get<{
        Params: { id: string };
        Querystring: { page?: string; folderId?: string; recursive?: string };
      }>("/bases/:id/files", async (request) => {
        const page = Number(request.query.page ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
          throw new KnowledgeError("页码无效");
        const folderId = text(request.query.folderId ?? "");
        if (folderId && !/^[A-Za-z0-9-]{1,36}$/.test(folderId))
          throw new KnowledgeError("目录参数无效");
        const recursive = text(request.query.recursive ?? "");
        if (recursive && recursive !== "1" && recursive !== "true")
          throw new KnowledgeError("目录参数无效");
        const data = record(
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/files?page=${page}${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""}${recursive ? "&recursive=true" : ""}`,
          ),
        );
        if (!Array.isArray(data.files))
          throw new KnowledgeError("文件列表格式无效", 502);
        return {
          files: data.files.map((value) => {
            const file = record(value);
            return {
              id: text(file.id),
              name: text(file.name),
              status: text(file.status),
              message: text(file.message),
              folderId: text(file.folderId),
            };
          }),
          total: typeof data.total === "number" ? data.total : 0,
          page,
        };
      });
      scoped.post<{ Params: { id: string } }>(
        "/bases/:id/files",
        { bodyLimit: MAX_UPLOAD_REQUEST_BYTES },
        async (request) => {
          const contentType = headerText(request.headers["content-type"]);
          const raw = request.body;
          if (
            !contentType.toLowerCase().startsWith("multipart/form-data") ||
            !(raw instanceof Uint8Array) ||
            raw.byteLength === 0
          )
            throw new KnowledgeError("文件参数无效");
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/files`,
            "POST",
            { raw, contentType },
          );
          return { ok: true };
        },
      );
      scoped.patch<{ Params: { id: string; fileId: string } }>(
        "/bases/:id/files/:fileId",
        async (request) => {
          const body = record(request.body);
          if (Object.keys(body).some((key) => key !== "folderId"))
            throw new KnowledgeError("文件参数无效");
          const folderId = text(body.folderId ?? "");
          if (!/^[A-Za-z0-9-]{0,36}$/.test(folderId))
            throw new KnowledgeError("目录参数无效");
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/files/${encodeURIComponent(request.params.fileId)}`,
            "PATCH",
            { folderId },
          );
          return { ok: true };
        },
      );
      scoped.get<{ Params: { id: string } }>("/bases/:id/folders", async (request) => {
        const data = record(
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/folders`,
          ),
        );
        const list = Array.isArray(data.folders) ? data.folders : [];
        return {
          folders: list.map((value) => {
            const folder = record(value);
            return {
              id: text(folder.id),
              parentId: text(folder.parentId),
              name: text(folder.name),
            };
          }),
        };
      });
      scoped.post<{ Params: { id: string } }>("/bases/:id/folders", async (request) => {
        const body = record(request.body);
        if (
          Object.keys(body).some((key) => !["name", "parentId"].includes(key))
        )
          throw new KnowledgeError("目录参数无效");
        if (!text(body.name).trim() || text(body.name).trim().length > 200)
          throw new KnowledgeError("目录名称无效");
        const parentId = text(body.parentId ?? "");
        if (parentId && !/^[A-Za-z0-9-]{1,36}$/.test(parentId))
          throw new KnowledgeError("目录参数无效");
        return client.request(
          `/bases/${encodeURIComponent(request.params.id)}/folders`,
          "POST",
          { name: text(body.name).trim(), ...(parentId ? { parentId } : {}) },
        );
      });
      scoped.patch<{ Params: { folderId: string } }>(
        "/folders/:folderId",
        async (request) => {
          const body = record(request.body);
          if (
            Object.keys(body).some(
              (key) => !["name", "parentId"].includes(key),
            ) ||
            (!("name" in body) && !("parentId" in body))
          )
            throw new KnowledgeError("目录参数无效");
          if (
            "name" in body &&
            (!text(body.name).trim() || text(body.name).trim().length > 200)
          )
            throw new KnowledgeError("目录名称无效");
          const patch: Record<string, unknown> = {};
          if ("name" in body) patch.name = text(body.name).trim();
          if ("parentId" in body) {
            const parentId = text(body.parentId ?? "");
            if (parentId && !/^[A-Za-z0-9-]{1,36}$/.test(parentId))
              throw new KnowledgeError("目录参数无效");
            patch.parentId = parentId;
          }
          return client.request(
            `/folders/${encodeURIComponent(request.params.folderId)}`,
            "PATCH",
            patch,
          );
        },
      );
      scoped.delete<{ Params: { folderId: string } }>(
        "/folders/:folderId",
        async (request) => {
          const body = record(request.body);
          if (Object.keys(body).some((key) => key !== "mode"))
            throw new KnowledgeError("目录参数无效");
          const mode = text(body.mode);
          if (mode !== "out" && mode !== "all")
            throw new KnowledgeError("目录参数无效");
          await client.request(
            `/folders/${encodeURIComponent(request.params.folderId)}`,
            "DELETE",
            { mode },
          );
          return { ok: true };
        },
      );
      scoped.delete<{ Params: { id: string; fileId: string } }>(
        "/bases/:id/files/:fileId",
        async (request) => {
          const body = record(request.body);
          if (Object.keys(body).some((key) => key !== "page"))
            throw new KnowledgeError("文件参数无效");
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/files/${encodeURIComponent(request.params.fileId)}`,
            "DELETE",
            body,
          );
          return { ok: true };
        },
      );
      scoped.post("/recall", async (request) => {
        const body = record(request.body);
        if (
          Object.keys(body).some((key) => key !== "query") ||
          !text(body.query).trim() ||
          text(body.query).length > 8000
        )
          throw new KnowledgeError("检索问题无效");
        return client.recall(text(body.query));
      });
    },
    { prefix: "/api/knowledge" },
  );
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
