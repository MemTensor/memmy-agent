import { afterEach, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";

const databases: MemoryDb[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const code = "summary_model_unconfigured";
function fixture() {
  const db = new MemoryDb({path: ":memory:"}); databases.push(db);
  const repos = new Repositories(db.db);
  function add(id: string, kind = "observed_activity", status = "pending", error: string | null = null, deleted: string | null = null) {
    db.db.prepare(`INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,created_at,updated_at,properties_json,deleted_at)
      VALUES(?,'owner','now','body','L1','now','now',?,?)`).run(id, JSON.stringify({internal_info:{memory_kind:kind,observation_memory:{status}}}), deleted);
    db.db.prepare("INSERT INTO memory_processing_state(memory_id,state,error_code,updated_at) VALUES(?,'summary_pending',?,'now')").run(id,error);
  }
  return {db,repos,add};
}
it("selects only pending, visible observations whose model configuration state must change", () => {
  const {db,repos,add} = fixture();
  add("missing"); add("held",undefined,undefined,code); add("other-error",undefined,undefined,"transient");
  add("ordinary","trace"); add("processed",undefined,"processed"); add("deleted",undefined,undefined,null,"now");
  add("embedding"); db.db.exec("UPDATE memory_processing_state SET state='embedding_pending' WHERE memory_id='embedding'");
  expect(repos.processing.listObservationConfigurationChanges(false,code)).toEqual(["missing","other-error"]);
  expect(repos.processing.listObservationConfigurationChanges(true,code)).toEqual(["held"]);
  db.db.exec("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.observation_memory.status','processed') WHERE id='held'");
  expect(repos.processing.listObservationConfigurationChanges(true,code)).toEqual([]);
});
it("uses the observation index without hydrating an unrelated pending backlog", () => {
  const {db,repos,add} = fixture();
  db.db.transaction(() => { for(let i=0;i<2000;i++) add(`ordinary-${i}`,"trace"); })();
  add("observation");
  const prepare = vi.spyOn(db.db,"prepare");
  expect(repos.processing.listObservationConfigurationChanges(false,code)).toEqual(["observation"]);
  expect(prepare).toHaveBeenCalledTimes(1);
  const sql = prepare.mock.calls[0]![0]; prepare.mockRestore();
  const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(code,10000) as Array<{detail:string}>;
  expect(plan[0]?.detail).toContain("idx_memories_observation_config_pending");
  expect(plan.some(row => row.detail.includes("SEARCH p USING INDEX"))).toBe(true);
});
