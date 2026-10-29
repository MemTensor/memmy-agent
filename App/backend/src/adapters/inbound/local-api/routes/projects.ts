/** Local project utilities: the managed folder a project without a chosen directory runs in, and project instructions. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import { MAX_PROJECT_INSTRUCTIONS_CHARS } from "@memmy/local-api-contracts";
import type { ProjectDirectoryService } from "../../../../services/project-directory-service.js";
import type { ProjectInstructionsService } from "../../../../services/project-instructions-service.js";

export interface RegisterProjectRoutesOptions {
  /** 按名称创建项目时用的托管目录；未提供时只注册项目指令接口。 */
  projectDirectory?: ProjectDirectoryService;
  /** 本机项目的项目指令：只属于这台电脑上的文件夹，协作项目有自己的一套接口。 */
  projectInstructions?: ProjectInstructionsService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const PrepareDirectorySchema = z.object({
  name: z.string().trim().min(1, "请填写项目名称").max(60, "项目名称过长")
}).strict();
/** 目录是项目任务所在位置：绝对路径，且长度与各平台路径上限一致。 */
const DirectorySchema = z.string().trim().min(1).max(4_096).refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), "项目目录需为绝对路径");
const ReadInstructionsSchema = z.object({ directory: DirectorySchema }).strict();
const SaveInstructionsSchema = z.object({
  directory: DirectorySchema,
  text: z.string().max(MAX_PROJECT_INSTRUCTIONS_CHARS * 4).default("")
}).strict();

/** Registers the local project routes. */
export function registerProjectRoutes(app: FastifyInstance, options: RegisterProjectRoutesOptions): void {
  // A project created by name alone still needs a working directory: this is where it gets one.
  if (options.projectDirectory) {
    app.post("/api/projects/working-directory", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
      const input = PrepareDirectorySchema.parse(request.body ?? {});
      return reply.send(await options.projectDirectory!.prepareManagedDirectory(input.name));
    }));
  }

  if (!options.projectInstructions) return;
  // 看板打开项目配置时读当前生效的指令；协作项目的指令由云端同步到同一份存储。
  app.get("/api/projects/instructions", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = ReadInstructionsSchema.parse(request.query ?? {});
    return reply.send(await options.projectInstructions!.read(input.directory));
  }));
  // 只有本机项目在这里保存；协作项目走云端的项目接口，再由后端同步到本机。
  app.put("/api/projects/instructions", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = SaveInstructionsSchema.parse(request.body ?? {});
    if ([...input.text.trim()].length > MAX_PROJECT_INSTRUCTIONS_CHARS) {
      return reply.status(400).send({ error: { code: "invalid_argument", message: `项目指令不超过 ${MAX_PROJECT_INSTRUCTIONS_CHARS} 字` } });
    }
    return reply.send(await options.projectInstructions!.saveLocal(input.directory, input.text));
  }));
}
