// Development fixture for desktop project-memory integration. All data is process-local.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";

export function createMockProjectGateway() {
  const app = Fastify();
  const accounts = new Map();
  app.all("/api/memmy/project-memory/*", async (req, res) => {
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith("Bearer ")) return res.code(401).send({ code: 401, message: "Sign in" });
    const owner = createHash("sha256").update(bearer).digest("hex");
    if (!accounts.has(owner)) accounts.set(owner, { submissions: new Map(), topics: [], tasks: new Map() });
    const state = accounts.get(owner);
    const [operation, id] = req.params["*"].split("/");
    const b = req.body ?? {}, q = req.query;
    const projects = b.project_ids ?? [];
    const visible = state.topics.filter(t => projects.includes(t.project_id));
    let data;
    switch (operation) {
      case "add": {
        const existing = state.submissions.get(b.submission_id);
        if (existing && existing.body !== JSON.stringify(b)) return res.code(409).send({ code: 409 });
        if (existing) { data = existing.data; break; }
        const topic = { project_id: projects[0], id: "topic_" + b.submission_id, topic_name: b.messages[0].content,
          topic_summary: b.messages.at(-1).content, topic_description: "", decisions: [], experiences: [], timeline: [] };
        data = { task_id: "task_" + b.submission_id, status: "completed", updated_topic_ids: [topic.id] };
        state.topics.unshift(topic);
        state.tasks.set(data.task_id, data);
        state.submissions.set(b.submission_id, { body: JSON.stringify(b), data });
        break;
      }
      case "submissions": data = state.submissions.get(id)?.data ?? { status: "not_accepted" }; break;
      case "status": data = state.tasks.get(id); break;
      case "index": data = { projects: projects.map(project_id => ({ project_id, topics: visible.filter(t => t.project_id === project_id).slice(0,b.size) })) }; break;
      case "search": data = b.view === "trajectory" ? { trajectories: [], degraded: [] }
        : { topics: visible.filter(t => (t.topic_name + t.topic_summary).includes(b.query)).slice(0,b.limit), degraded: [] }; break;
      case "topics": {
        if (id) data = state.topics.find(t => t.project_id === q.project_id && t.id === id);
        else {
          const topics = state.topics.filter(t => t.project_id === b.project_id);
          data = { topics: topics.slice((b.page-1)*b.size,b.page*b.size), total: topics.length, page: b.page, size: b.size };
        }
        break;
      }
      case "items": {
        const topic = state.topics.find(t => t.id === id && t.project_id === q.project_id);
        if (topic) data = { project_id: q.project_id, memory_id: id, kind: "topic", cache_policy: "live",
          ...(q.view !== "metadata" ? { content: topic } : {}) };
        break;
      }
    }
    return data ? { code: 0, data } : res.code(404).send({ code: 404, message: "Not found" });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = await createMockProjectGateway().listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 4198) });
  console.log("Mock project-memory gateway listening at " + url);
}
