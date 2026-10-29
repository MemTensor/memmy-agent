/**
 * 添加知识库到项目时的候选列表：只读本人的知识库设置，取库名、id 与已有的归属信息。
 *
 * <p>候选只来自本人可访问的库——关联不会带来新的访问权，所以能选的就是本人在知识库页面看得到的那些。
 * 服务未就绪或未登录时返回空列表，弹窗里表现为「暂无可关联的知识库」。</p>
 */
import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "./http.js";

const SettingsSchema = z.object({
  serviceAvailable: z.boolean().nullish().transform((value) => value ?? false),
  bases: z.array(z.object({
    id: z.string(),
    name: z.string(),
    shared: z.boolean().optional(),
    sharedByMe: z.boolean().optional(),
    ownerName: z.string().optional()
  })).nullish().transform((value) => value ?? [])
});

export interface KnowledgeBaseOption {
  id: string;
  name: string;
  shared?: boolean;
  sharedByMe?: boolean;
  ownerName?: string;
}

export async function listKnowledgeBases(config: RuntimeConfig): Promise<KnowledgeBaseOption[]> {
  try {
    const settings = await requestJson({ config, path: "/api/knowledge/settings", schema: SettingsSchema });
    if (!settings.serviceAvailable) return [];
    return settings.bases;
  } catch {
    // 知识库服务不可用时，项目配置里的候选为空，不影响项目本身的其他配置。
    return [];
  }
}
