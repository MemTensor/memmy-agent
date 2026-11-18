import { z } from "zod";
import { isAbsolute } from "node:path";

export const id = z.string().trim().min(1).max(1024);
const folder = z.string().max(8192).refine(value => isAbsolute(value) && !value.includes("\0"), "Expected an absolute folder path");
export const project = z.object({ project_id: id });
export const bindings = project.extend({ workspace_ids: z.array(id), folder_paths: z.array(folder) }).strict();
export const session = z.object({
  source: id, conversation_id: id, workspace_id: id.optional(), cwd: folder.optional(),
  workspace_roots: z.array(folder).optional()
});
export const index = session.extend({ size: z.number().int().min(1).max(50).default(8) });
export const search = session.extend({
  turn_id: id, query: z.string().trim().min(1), domains: z.array(id).nonempty().optional(),
  limit: z.number().int().min(1).max(25).default(9), view: z.enum(["topic", "trajectory"]).default("topic"),
  include_index: z.boolean().optional()
}).strict();
const message = z.object({
  role: z.enum(["user", "assistant"]), content: z.string().min(1), chat_time: z.iso.datetime({ offset: true }).optional(),
  message_id: id.optional(), role_id: id.optional(), role_name: id.optional()
}).strict();
export const add = session.extend({
  turn_id: id, submission_id: id, messages: z.array(message).nonempty(), domains: z.array(id).nonempty().optional()
}).strict();
export const historyImport = session.extend({
  confirmed: z.literal(true), submission_id: id, project_ids: z.array(id).nonempty(),
  messages: z.array(message.extend({ chat_time: z.iso.datetime({ offset: true }), message_id: id })).nonempty(),
  domains: z.array(id).nonempty().optional()
}).strict();
export type HistoryImport = z.infer<typeof historyImport>;
export const page = project.extend({ page: z.coerce.number().int().positive().default(1), size: z.coerce.number().int().min(1).max(50).default(20) });
export type Session = z.infer<typeof session>;
export type ProjectSearch = z.infer<typeof search>;
export type ProjectAdd = z.infer<typeof add>;
export const record = z.record(z.string(), z.unknown());
export const records = z.array(record);
