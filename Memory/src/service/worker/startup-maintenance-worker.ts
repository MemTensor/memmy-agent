import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "../../storage/db.js";
import { Repositories } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";
import { namespaceIdFromMemory } from "../external-evidence-source.js";
import { PolicyEvidenceMaintenance, type PolicyMaintenanceAlgorithm } from "../evolution/policy-evidence-maintenance.js";
import { AgentSkillLibrary, type SkillMaintenanceDeps } from "../import/agent-skill-library.js";
import { enqueueJob } from "./job-handlers.js";
import type { MaintenanceCommand, MaintenanceReply, MaintenanceTask } from "./startup-maintenance-thread.js";

const port = parentPort!;
const { path, task, writeEnabled } = workerData as { path: string; task: MaintenanceTask; writeEnabled: Int32Array };
const database = new MemoryDb({ path, skipMigrations: true });
const repos = new Repositories(database.db);
const enableMemoryAdd = () => Atomics.load(writeEnabled, 0) !== 0;
let embedAfterCapture = false;
let algorithm: PolicyMaintenanceAlgorithm;
function* maintenanceSteps() {
  if (task.type === "policies") {
    const policies = new PolicyEvidenceMaintenance(repos, () => algorithm);
    return yield* policies.steps(task.at, task.limit, enableMemoryAdd);
  }
  const skills = new AgentSkillLibrary<SkillMaintenanceDeps>({
    repos, nowIso, namespaceIdFromMemory,
    embedAfterCapture: () => embedAfterCapture,
    enqueueJob: input => enqueueJob({ repos, nowIso }, input)
  });
  if (task.type === "retrieval") yield* skills.upgradeRetrievalRepresentation(task.pageSize, enableMemoryAdd);
  else yield* skills.startupMaintenance(task.pageSize, enableMemoryAdd);
}
const steps = maintenanceSteps();
port.on("message", (command: MaintenanceCommand) => {
  try {
    if (command.type === "step") {
      embedAfterCapture = command.settings.embedAfterCapture;
      if (command.settings.algorithm) algorithm = command.settings.algorithm;
      const step = steps.next();
      if (!step.done) {
        port.postMessage({ type: "next" } satisfies MaintenanceReply);
        return;
      }
      port.postMessage({ type: "done", result: step.value } satisfies MaintenanceReply);
    }
  } catch (error) {
    database.close();
    port.close();
    throw error;
  }
  database.close();
  port.close();
});
