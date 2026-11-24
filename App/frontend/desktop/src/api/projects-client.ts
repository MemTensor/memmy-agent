import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "./http.js";

const DirectoryResponseSchema = z.object({ path: z.string() });

/**
 * 项目指令：项目里所有任务要遵循的背景与规范。
 * `origin` 说明这份指令是本机编辑的，还是从协作项目同步过来的；`null` 表示还没有设定。
 */
const ProjectInstructionsSchema = z.object({
  text: z.string(),
  origin: z.enum(["local", "cloud"]).nullable(),
  cloudProjectId: z.string().nullable(),
  updatedAt: z.string().nullable()
});
export type ProjectInstructions = z.infer<typeof ProjectInstructionsSchema>;

/** 读取某个项目当前生效的指令；看板的项目配置与保存后的回填都走它。 */
export async function readProjectInstructions(config: RuntimeConfig, directory: string): Promise<ProjectInstructions> {
  return requestJson({
    config,
    path: `/api/projects/instructions?directory=${encodeURIComponent(directory)}`,
    schema: ProjectInstructionsSchema
  });
}

/** 保存本机项目的指令。协作项目的指令以云端为准，由 {@link CollabClient.setInstructions} 保存后同步回来。 */
export async function saveProjectInstructions(
  config: RuntimeConfig,
  directory: string,
  text: string
): Promise<ProjectInstructions> {
  return requestJson({
    config,
    path: "/api/projects/instructions",
    schema: ProjectInstructionsSchema,
    body: { directory, text },
    init: { method: "PUT" }
  });
}

/**
 * The folder a project runs its tasks in when the person did not pick one. It lives next to the project cache,
 * so a name-only project still has somewhere to work instead of borrowing a folder nobody chose.
 */
export async function prepareProjectDirectory(config: RuntimeConfig, name: string): Promise<string> {
  const result = await requestJson({
    config,
    path: "/api/projects/working-directory",
    schema: DirectoryResponseSchema,
    body: { name },
    init: { method: "POST" }
  });
  return result.path;
}
