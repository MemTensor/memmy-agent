# MemoryService test index

The `tests/service` tree groups `MemoryService` integration tests by behavior. Test titles stay unchanged during migration so failures remain searchable with `rg` and Vitest `-t`.

| Domain | Topic | File | Describe prefix | Primary interface | Layer |
|---|---|---|---|---|---|
| Facade | Config and storage | `facade/config-and-storage.test.ts` | `MemoryService / facade / config and storage` | `health`, `reloadConfig`, storage wiring, write gates | integration |
| Retrieval | Query and filtering | `retrieval/query-and-filter.test.ts` | `MemoryService / retrieval / query and filtering` | `startTurn`, `search`, query rewrite, candidate filter | integration |
| Retrieval | Injected context | `retrieval/injected-context.test.ts` | `MemoryService / retrieval / injected context` | recall packets, decision guidance, intent gates | integration |
| Import | Processing | `import/import-processing.test.ts` | `MemoryService / import / processing` | source import, summary, processing state, ordering | integration |
| Embedding | Processing | `embedding/embedding-processing.test.ts` | `MemoryService / embedding / processing` | trace embedding, retry, captured-trace embedding | integration |
| Worker | Runtime | `worker/worker-runtime.test.ts` | `MemoryService / worker / runtime` | `nextWorkerRunAt`, `runWorkerOnce`, lease retry, requeue, dead letter | integration |
| Session | Lifecycle | `session/session-lifecycle.test.ts` | `MemoryService / session / lifecycle` | open/reopen session, idempotency, turn artifacts | integration |
| Session | Turn capture | `session/turn-capture.test.ts` | `MemoryService / session / turn capture` | normalization, tool capture, sanitization, compact/tool/subagent envelopes | integration |
| Session | Episode relation | `session/episode-relation.test.ts` | `MemoryService / session / episode relation` | new task, follow-up, revision, episode reservation | integration |
| Session | Idle sweep | `session/idle-sweep.test.ts` | `MemoryService / session / idle sweep` | idle close, activity time, sweep deduplication | integration |
| Read model | Panel | `read-model/panel-read.test.ts` | `MemoryService / read model / panel` | logs, panel items/tasks/overview/changes/jobs | integration |
| Read model | Memory detail | `read-model/memory-read.test.ts` | `MemoryService / read model / memory detail` | `getMemory`, incomplete trace payload filtering | integration |
| Read model | Skill list | `read-model/skill-read.test.ts` | `MemoryService / read model / skill list` | `listSkills`, namespace pagination | integration |
| Evolution | Reflection | `evolution/reflection.test.ts` | `MemoryService / evolution / reflection` | batch reflection, alpha, social-step classification | integration |
| Evolution | Reward | `evolution/reward.test.ts` | `MemoryService / evolution / reward` | episode reward, R_human, reward backpropagation | integration |
| Evolution | Policy induction | `evolution/policy-induction.test.ts` | `MemoryService / evolution / policy induction` | L2 association, support, promotion, induction | integration |
| Evolution | World model | `evolution/world-model.test.ts` | `MemoryService / evolution / world model` | L3 abstraction, merge, cooldown, invalid draft | integration |
| Evolution | Skill lifecycle | `evolution/skill-lifecycle.test.ts` | `MemoryService / evolution / skill lifecycle` | crystallization, debounce, archival, reward drift | integration |
| Evolution | Orchestration | `evolution/orchestration.test.ts` | `MemoryService / evolution / orchestration` | cross-domain L2/L3/Skill worker chains | integration |
| Feedback | Decision repair | `feedback/decision-repair.test.ts` | `MemoryService / feedback / decision repair` | repair creation/retrieval, tool-failure bursts, reward divergence | integration |
| Feedback | Experience | `feedback/experience.test.ts` | `MemoryService / feedback / experience` | feedback-derived experience policies and model refinement | integration |
| Trials | Skill trial | `trials/skill-trial.test.ts` | `MemoryService / trials / skill trial` | neutral reward trial resolution and retry | integration |
| Lifecycle | Governance | `lifecycle/memory-lifecycle.test.ts` | `MemoryService / lifecycle / governance` | redact, archive, delete, import conflicts, audit logs | integration |
| Bundle | Cross-namespace export | `bundle/bundle.test.ts` | `MemoryService / bundle` | bundle contents across user namespaces | integration |
| REST contract | HTTP seam | `../contract/memory-rest-service.test.ts` | `MemoryService / REST contract` | auth, DTOs, routes, worker drain, startup, shutdown | contract |

## Find and run tests

Run these commands from the `Memory` package directory:

```bash
rg -n 'reloads runtime model config' tests
npx vitest run tests/service/facade/config-and-storage.test.ts
npx vitest run tests/service/facade/config-and-storage.test.ts \
  -t 'reloads runtime model config without replacing the storage backend'
npx vitest run tests/service/retrieval
npx vitest run tests/service/retrieval/query-and-filter.test.ts \
  -t 'rewrites the retrieval query only when enabled'
npx vitest run tests/service/import/import-processing.test.ts
npx vitest run tests/service/embedding/embedding-processing.test.ts
npx vitest run tests/service/worker/worker-runtime.test.ts
npx vitest run tests/service/session
npx vitest run tests/service/session/episode-relation.test.ts \
  -t 'keeps follow-up turns in the same episode'
npx vitest run tests/service/read-model
npx vitest run tests/service/read-model/panel-read.test.ts \
  -t 'shows panel change logs, jobs, and overview across namespaces'
npx vitest run tests/service/evolution
npx vitest run tests/service/evolution/policy-induction.test.ts \
  -t 'uses the plugin L2 induction prompt contract and stores policy confidence'
npx vitest run tests/service/feedback tests/service/trials
npx vitest run tests/service/feedback/decision-repair.test.ts \
  -t 'turns repeated observed tool failures into a cooldown-guarded decision repair'
npx vitest run tests/service/lifecycle tests/service/bundle
npx vitest run tests/service/lifecycle/memory-lifecycle.test.ts
npx vitest run tests/contract/memory-rest-service.test.ts
npx vitest run tests/service
```

## Fixture dependencies

- Test files may import shared infrastructure from `tests/fixtures`.
- Test files must not import other test files.
- Domain-specific model stubs stay with their owning test module unless multiple domains require identical behavior and failure modes.
- Evolution model stubs shared by Evolution test files live in `evolution/evolution-llm-stubs.ts`.
- Decision-repair evolution setup stays in `feedback/decision-repair-llm-stub.ts` and is not imported from Evolution.
- Each test file must register fixture cleanup explicitly with `afterEach`.

The REST contract suite requires permission to listen on `127.0.0.1`; the facade suite does not open a local server.
