import type { Repositories } from "../../storage/repositories.js";
import type { FairClaimedWork } from "./fair-worker-queue.js";
import { jobPolicyRegistry, UnknownJobPolicyError } from "./job-policy-registry.js";
import type { PreparedWorkerExecution, WorkerRequirements } from "./worker-concurrency.js";

function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

/** Scope keys describe shared business state, rather than an individual job type. */
export function workerWorkRequirements(
  work: FairClaimedWork,
  repos: Pick<Repositories, "memories" | "runtime"> & Partial<Pick<Repositories, "l3WorldModels">>,
  execution?: PreparedWorkerExecution
): WorkerRequirements {
  const job = work.queue === "main" ? work.job : undefined;
  const targetId = job?.targetMemoryId ?? (work.queue === "embedding_retry" ? work.retry.targetId : undefined);
  const payload = job?.payload ?? {};
  let policy;
  try {
    // Target metadata affects lane/urgency, not these execution requirements.
    // Avoid reading long conversation bodies while skipping resource-blocked rows.
    policy = jobPolicyRegistry.resolve({ jobType: job?.jobType ?? "embedding_retry", payload });
  } catch (error) {
    if (!(error instanceof UnknownJobPolicyError)) throw error;
    return { resourceClass: "database", providers: [], scopeKeys: targetId ? [JSON.stringify(["target", targetId])] : [] };
  }
  const scopeKeys = targetId ? [JSON.stringify(["target", targetId])] : [];
  if (policy.concurrency.scope === "episode") {
    const episode = job?.episodeId ?? text(payload.episodeId) ?? text(payload.episode_id);
    if (episode) scopeKeys.push(JSON.stringify(["episode", episode]));
  }
  if (policy.concurrency.scope === "user_project") {
    // Production L3 payloads contain only batchId/targetField; Work Memory
    // payloads contain only trajectory data. Their opaque scope hashes differ.
    // Resolve the authoritative project so both share the same business permit.
    const session = job?.sessionId ? repos.runtime.getSession(job.sessionId) : undefined;
    const batch = job?.jobType === "l3_world_model_update" && text(payload.batchId)
      ? repos.l3WorldModels?.getBatch(String(payload.batchId)) : undefined;
    // Assignment discovers its destination cluster only after model work. Both
    // Skill operations therefore reserve the project, using their persisted
    // episode/cluster rather than a missing target or a possibly absent session.
    const skillOperation = job?.jobType === "skill_cluster_assign" || job?.jobType === "skill_batch_evolve";
    const skillEpisode = skillOperation && job?.episodeId ? repos.runtime.getEpisode(job.episodeId) : undefined;
    const skillCluster = job?.jobType === "skill_batch_evolve" && text(payload.clusterId)
      ? repos.runtime.getSkillCluster(String(payload.clusterId)) : undefined;
    const memory = !batch && !session && !skillEpisode && !skillCluster && targetId ? repos.memories.get(targetId) : undefined;
    const internal = memory?.properties.internal_info;
    const project = batch ? batch.projectId ?? null : skillCluster ? skillCluster.projectId ?? null
      : skillEpisode ? skillEpisode.projectId ?? null : session ? session.projectId ?? null
      : text(payload.projectId) ?? text(payload.project_id) ?? text(internal?.project_id)
        ?? text(internal?.projectId) ?? job?.scopeKey ?? null;
    const sharedProject = typeof project === "string"
      ? repos.l3WorldModels?.sharedProjectIds(project).slice().sort()[0] ?? project : project;
    scopeKeys.push(JSON.stringify(["user_project", sharedProject]));
  }
  return { queueLane: work.queue === "main" ? work.job.queueLane ?? undefined : work.retry.queueLane ?? undefined,
    resourceClass: policy.resourceClass, providers: execution?.providers ?? [], scopeKeys,
    embedding: execution?.embedding === true || policy.concurrency.providerRoles.includes("embedding") };
}

/** Only neighbouring, compatible embedding items may share one request permit. */
export function workerEmbeddingGroupKey(work: FairClaimedWork, repos: Pick<Repositories, "memories">): string | undefined {
  if (work.queue === "embedding_retry") return `retry:${work.retry.embedRole}`;
  if (work.job.jobType !== "embedding") return undefined;
  const memory = work.job.targetMemoryId ? repos.memories.get(work.job.targetMemoryId) : undefined;
  return `main:${memory?.memoryLayer === "L1" ? "document" : "query"}`;
}
