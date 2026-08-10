# Authoritative Project Context Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed project goals, hard constraints, decisions, and a manually selected work item survive fresh sessions and CLI switches by injecting a bounded authoritative project context on every project-scoped turn.

**Architecture:** Add a project-context domain service backed by dedicated SQLite records scoped by the existing Memmy namespace. `turns/start` composes a stable authoritative section before existing supplemental retrieval, while local API clients, installed CLI hooks, and the existing Project Context Pack dialog expose proposal review and manual work-item focus. Existing Memory rows remain evidence and retrieval material, not the source of truth for project state.

**Tech Stack:** TypeScript 6, Node.js 20+, better-sqlite3, Zod 4, Fastify 5, React 19, Vitest 4.

## Global Constraints

- Preserve all existing workspace changes; `Memory/src/service/read-model/panel-read.ts` and retrieval files are already modified and must be re-read immediately before editing.
- Use the existing `RuntimeNamespace` and `namespaceIdFromContext`; do not introduce another project identifier.
- Exactly zero or one confirmed primary goal and zero or one focused work item may exist per namespace.
- Generated proposals remain non-authoritative until explicit approval.
- Short goals preserve their complete text; long goals preserve full `detail` while stable injection uses bounded `summary`.
- Work-item focus changes only by explicit mutation; ordinary turns never infer or switch focus.
- Stable project context precedes supplemental memory context and is fetched on every turn.
- Existing retrieval behavior remains supplemental and otherwise unchanged.
- Mutation requests carry namespace, source, adapter ID, request ID, and provenance.
- Write failing behavioral tests before each production change and observe the intended failure.

---

## File Structure

- `Memory/src/service/project-context/project-context-service.ts`: owns proposal, approval, goal versioning, work-item focus, context rendering, and invariants.
- `Memory/src/service/project-context/project-context-types.ts`: domain records and request/response contracts internal to Memory.
- `Memory/src/storage/schema.ts`: creates the three authoritative project-context tables and uniqueness indexes.
- `Memory/src/storage/repositories.ts`: persists project goals, work items, and confirmed facts in the current namespace.
- `Memory/src/service/session/session-turn-service.ts`: prepends authoritative context to the existing injected context and records its version in provenance.
- `Memory/src/types.ts`: public Memory service turn-start and project-context types.
- `Memory/src/service/memory-service.ts`: exposes project-context operations through the existing service facade.
- `Memory/src/server/http.ts`: Memory HTTP read/mutation routes.
- `App/backend/local-api-contracts/src/memory-runtime.ts`: Zod contracts shared by backend and UI.
- `App/backend/src/adapters/outbound/memory-client/*`: Memory client operations and endpoint map.
- `App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts`: authenticated local project-context routes.
- `App/backend/src/services/panel-service.ts`: local service facade.
- `App/backend/src/adapters/outbound/skill-writer/templates/memmy-resume-hook.ts`: marks authoritative project context separately and records the injected version.
- `App/frontend/desktop/src/pages/project-context-pack-dialog.tsx`: goal review, work-item selection, and authoritative state display.

---

### Task 1: Persist Authoritative Project Context

**Files:**
- Create: `Memory/src/service/project-context/project-context-types.ts`
- Modify: `Memory/src/storage/schema.ts`
- Modify: `Memory/src/storage/repositories.ts`
- Test: `Memory/tests/repository/project-context-repository.test.ts`
- Test: `Memory/tests/repository/sqlite-schema.test.ts`

**Interfaces:**
- Produces `ProjectGoalRecord`, `ProjectWorkItemRecord`, `ProjectFactRecord`, and `ProjectContextRepository`.
- `ProjectContextRepository` methods:

```ts
interface ProjectContextRepository {
  getActiveGoal(namespaceId: string): ProjectGoalRecord | undefined;
  getGoal(id: string): ProjectGoalRecord | undefined;
  listGoals(namespaceId: string): ProjectGoalRecord[];
  insertGoal(goal: ProjectGoalRecord): ProjectGoalRecord;
  replaceActiveGoal(next: ProjectGoalRecord): ProjectGoalRecord;
  getFocusedWorkItem(namespaceId: string): ProjectWorkItemRecord | undefined;
  listWorkItems(namespaceId: string): ProjectWorkItemRecord[];
  insertWorkItem(item: ProjectWorkItemRecord): ProjectWorkItemRecord;
  updateWorkItem(item: ProjectWorkItemRecord): ProjectWorkItemRecord;
  setFocusedWorkItem(namespaceId: string, itemId: string | null, at: string): ProjectWorkItemRecord | undefined;
  listActiveFacts(namespaceId: string): ProjectFactRecord[];
  insertFact(fact: ProjectFactRecord): ProjectFactRecord;
  supersedeFact(previousId: string, next: ProjectFactRecord): ProjectFactRecord;
}
```

- [ ] **Step 1: Write failing repository tests**

Create tests proving:

```ts
it("allows only one active goal per namespace", () => {
  repo.insertGoal(goal({ id: "goal-1", namespaceId: "ns-1", status: "active", version: 1 }));
  expect(() => repo.insertGoal(goal({ id: "goal-2", namespaceId: "ns-1", status: "active", version: 2 })))
    .toThrow(/active project goal/i);
});

it("focuses exactly one work item without changing the goal", () => {
  repo.insertGoal(goal({ id: "goal-1", namespaceId: "ns-1", status: "active", version: 1 }));
  repo.insertWorkItem(workItem({ id: "work-1", namespaceId: "ns-1" }));
  repo.insertWorkItem(workItem({ id: "work-2", namespaceId: "ns-1" }));
  repo.setFocusedWorkItem("ns-1", "work-1", NOW);
  repo.setFocusedWorkItem("ns-1", "work-2", NOW);
  expect(repo.getFocusedWorkItem("ns-1")?.id).toBe("work-2");
  expect(repo.getActiveGoal("ns-1")?.id).toBe("goal-1");
});

it("rejects cross-namespace focus", () => {
  repo.insertWorkItem(workItem({ id: "work-other", namespaceId: "ns-2" }));
  expect(() => repo.setFocusedWorkItem("ns-1", "work-other", NOW)).toThrow(/namespace/i);
});
```

Extend the schema test to assert the new tables and indexes exist.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm --prefix Memory test -- tests/repository/project-context-repository.test.ts tests/repository/sqlite-schema.test.ts
```

Expected: failure because the records, repository, and tables do not exist.

- [ ] **Step 3: Add domain record types**

Define records with explicit statuses:

```ts
export type ProjectGoalStatus = "candidate" | "active" | "completed" | "archived";
export type ProjectWorkItemStatus = "pending" | "active" | "blocked" | "completed" | "archived";
export type ProjectFactKind = "decision" | "constraint";
export type ProjectFactStatus = "candidate" | "active" | "superseded" | "archived";
```

Each record includes `id`, `namespaceId`, `userId`, optional `projectId`, optional `workspaceId`, optional `workspacePath`, content fields, `sourceMemoryIds`, `provenance`, `createdAt`, and `updatedAt`. Goals additionally include `version` and `supersedesId`; work items include `focused`; facts include `kind` and `supersedesId`.

- [ ] **Step 4: Add schema tables and indexes**

Add `project_context_goals`, `project_context_work_items`, and `project_context_facts`. Store arrays and provenance as JSON text. Add partial unique indexes:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_context_active_goal
ON project_context_goals(namespace_id)
WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_context_focused_work_item
ON project_context_work_items(namespace_id)
WHERE focused = 1;
```

Use foreign keys for `supersedes_id` and work-item `goal_id`. Increment `SCHEMA_VERSION` and allow migration from the immediately previous version.

- [ ] **Step 5: Implement repository methods transactionally**

`replaceActiveGoal` archives the prior active goal, inserts the next version with `supersedesId`, and commits atomically. `setFocusedWorkItem` clears current focus and sets the requested item in one transaction. Reject records whose stored namespace differs from the mutation namespace.

- [ ] **Step 6: Run repository tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 7: Commit the storage unit**

```bash
git add Memory/src/service/project-context/project-context-types.ts Memory/src/storage/schema.ts Memory/src/storage/repositories.ts Memory/tests/repository/project-context-repository.test.ts Memory/tests/repository/sqlite-schema.test.ts
git commit -m "feat(memory): persist authoritative project context"
```

---

### Task 2: Implement Goal Approval, Work Items, And Stable Rendering

**Files:**
- Create: `Memory/src/service/project-context/project-context-service.ts`
- Create: `Memory/tests/service/project-context/project-context-service.test.ts`
- Modify: `Memory/src/types.ts`
- Modify: `Memory/src/service/memory-service.ts`

**Interfaces:**
- Consumes `ProjectContextRepository` from Task 1.
- Produces:

```ts
interface StableProjectContext {
  namespaceId: string;
  status: "ready" | "no_confirmed_goal" | "conflict";
  version: number;
  goal: ProjectGoalRecord | null;
  focusedWorkItem: ProjectWorkItemRecord | null;
  facts: ProjectFactRecord[];
  markdown: string;
  sourceMemoryIds: string[];
  generatedAt: string;
}

class ProjectContextService {
  read(namespace: RuntimeNamespace): ProjectContextState;
  proposeGoal(input: ProposeProjectGoalRequest): Promise<ProjectGoalRecord>;
  approveGoal(input: ApproveProjectGoalRequest): ProjectGoalRecord;
  rejectGoal(input: RejectProjectGoalRequest): ProjectGoalRecord;
  createWorkItem(input: CreateProjectWorkItemRequest): ProjectWorkItemRecord;
  updateWorkItem(input: UpdateProjectWorkItemRequest): ProjectWorkItemRecord;
  selectWorkItem(input: SelectProjectWorkItemRequest): ProjectWorkItemRecord | null;
  renderStable(namespace: RuntimeNamespace, budget?: number): StableProjectContext;
}
```

- [ ] **Step 1: Write failing service tests**

Cover these observable contracts:

```ts
it("does not render an unconfirmed goal proposal", async () => {
  await service.proposeGoal(proposalInput({ title: "Candidate only" }));
  expect(service.renderStable(NS).status).toBe("no_confirmed_goal");
  expect(service.renderStable(NS).markdown).not.toContain("Candidate only");
});

it("renders an approved goal for an unrelated prompt", async () => {
  const candidate = await service.proposeGoal(proposalInput({ title: "Ship reliable project memory" }));
  service.approveGoal(approveInput(candidate.id));
  const stable = service.renderStable(NS);
  expect(stable.markdown).toContain("Ship reliable project memory");
  expect(stable.version).toBe(1);
});

it("preserves long detail outside the bounded stable view", async () => {
  const detail = "Long goal ".repeat(2000);
  const candidate = await service.proposeGoal(proposalInput({ detail, summary: "Bounded summary" }));
  const active = service.approveGoal(approveInput(candidate.id));
  expect(service.read(NS).activeGoal?.detail).toBe(detail);
  expect(service.renderStable(NS, 1200).markdown).toContain("Bounded summary");
  expect(service.renderStable(NS, 1200).markdown).not.toContain(detail);
});

it("changes focused work item without changing the primary goal", async () => {
  const goal = await approveGoal(service, "Primary goal");
  const first = service.createWorkItem(workInput(goal.id, "First"));
  const second = service.createWorkItem(workInput(goal.id, "Second"));
  service.selectWorkItem(selectInput(first.id));
  service.selectWorkItem(selectInput(second.id));
  expect(service.renderStable(NS).goal?.id).toBe(goal.id);
  expect(service.renderStable(NS).focusedWorkItem?.id).toBe(second.id);
});

it("renders a non-blocking reminder when no work item is selected", async () => {
  await approveGoal(service, "Primary goal");
  expect(service.renderStable(NS).markdown).toContain("No work item is selected");
});
```

Also test goal supersession, candidate rejection, deterministic budget priority, active fact conflicts, and source-memory ID deduplication.

- [ ] **Step 2: Run service tests and verify RED**

```bash
npm --prefix Memory test -- tests/service/project-context/project-context-service.test.ts
```

Expected: failure because `ProjectContextService` does not exist.

- [ ] **Step 3: Implement proposal and approval rules**

`proposeGoal` creates only `candidate` records. For initial delivery, accept a normalized candidate payload produced by the authorized summarization caller; do not silently activate it. Keep the LLM proposal producer behind the existing project summarization flow instead of embedding model calls in the repository service.

`approveGoal` validates namespace and candidate status, assigns the next version, and calls `replaceActiveGoal`. `rejectGoal` archives the candidate without changing active state.

- [ ] **Step 4: Implement stable rendering**

Render a separate marker:

```md
<memmy_project_context version="3" status="ready">
# Confirmed Project Context
## Primary Goal
...
## Focused Work Item
...
## Hard Constraints
...
## Confirmed Decisions
...
</memmy_project_context>
```

Use deterministic section priorities: constraints, goal title/summary, focused work item/next step, acceptance criteria, decisions, metadata. If no goal exists, render only a compact `no confirmed project goal` state. Never render candidates.

- [ ] **Step 5: Expose facade methods from `MemoryService`**

Add read and mutation methods that resolve the existing namespace, enforce project scope, and delegate to `ProjectContextService`. Do not modify ordinary `addMemory` or search semantics.

- [ ] **Step 6: Run service tests and verify GREEN**

Run the command from Step 2. Expected: all service tests pass.

- [ ] **Step 7: Commit the domain unit**

```bash
git add Memory/src/service/project-context Memory/src/types.ts Memory/src/service/memory-service.ts Memory/tests/service/project-context
git commit -m "feat(memory): manage confirmed project goals"
```

---

### Task 3: Prepend Stable Project Context At Turn Start

**Files:**
- Modify: `Memory/src/types.ts`
- Modify: `Memory/src/service/session/session-turn-service.ts`
- Modify: `Memory/src/server/http.ts`
- Test: `Memory/tests/service/session/turn-capture.test.ts`
- Test: `Memory/tests/contract/memory-rest-service.test.ts`

**Interfaces:**
- Consumes `ProjectContextService.renderStable` from Task 2.
- Extends turn-start output with:

```ts
projectContext: {
  namespaceId: string;
  status: "ready" | "no_confirmed_goal" | "conflict";
  version: number;
  markdown: string;
  sourceMemoryIds: string[];
  generatedAt: string;
};
```

- `injectedContext.markdown` contains project context before supplemental retrieval.
- `sourceMemoryIds` remains the deduplicated union of authoritative evidence IDs and retrieval IDs.

- [ ] **Step 1: Add failing turn-start tests**

Add a test that approves a goal and hard constraint, starts a turn with an unrelated query, and asserts:

```ts
expect(started.projectContext.version).toBe(1);
expect(started.injectedContext.markdown.indexOf("<memmy_project_context"))
  .toBeLessThan(started.injectedContext.markdown.indexOf("<memmy_memory_context"));
expect(started.injectedContext.markdown).toContain("Never overwrite user changes");
```

Start a second turn after approving a revision and assert the next response has the new version without restarting the session. Add a cross-namespace test proving another workspace's goal is absent.

- [ ] **Step 2: Run turn-start tests and verify RED**

```bash
npm --prefix Memory test -- tests/service/session/turn-capture.test.ts tests/contract/memory-rest-service.test.ts
```

Expected: failure because turn-start does not return or prepend project context.

- [ ] **Step 3: Compose project context before retrieval context**

In `SessionTurnService.startTurn`, resolve `namespaceForSession(session)`, fetch `renderStable` on every call, and combine contexts without changing retrieval ranking:

```ts
const injectedContext = combineTurnContexts(projectContext, search.injectedContext);
const sourceMemoryIds = dedupe([...projectContext.sourceMemoryIds, ...search.sourceMemoryIds]);
```

Store `projectContextVersion`, `projectContextStatus`, and the combined source IDs in `rawTurn.messagePayload.turn_start`.

- [ ] **Step 4: Preserve no-write and public HTTP behavior**

Return the same explicit project-context shape in the no-write path with `status: "no_confirmed_goal"`. Extend `publicStartTurnResponse` without dropping the new field.

- [ ] **Step 5: Run turn-start tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 6: Commit the turn-start unit**

```bash
git add Memory/src/types.ts Memory/src/service/session/session-turn-service.ts Memory/src/server/http.ts Memory/tests/service/session/turn-capture.test.ts Memory/tests/contract/memory-rest-service.test.ts
git commit -m "feat(memory): inject confirmed project context"
```

---

### Task 4: Add Project Context HTTP And Local API Contracts

**Files:**
- Modify: `Memory/src/server/http.ts`
- Modify: `App/backend/local-api-contracts/src/memory-runtime.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/memory-layer-endpoints.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/types.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/http-memory-client.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/memos-sqlite-memory-client.ts`
- Modify: `App/backend/src/services/panel-service.ts`
- Modify: `App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts`
- Test: `App/backend/src/adapters/outbound/memory-client/tests/http-memory-client.test.ts`
- Test: `App/backend/src/adapters/outbound/memory-client/tests/memos-sqlite-memory-client.test.ts`
- Test: `App/backend/src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts`

**Interfaces:**
- Produces Zod schemas and clients for:
  - `GET /api/v1/project-context/state`
  - `POST /api/v1/project-context/goals/propose`
  - `POST /api/v1/project-context/goals/:id/approve`
  - `POST /api/v1/project-context/goals/:id/reject`
  - `POST /api/v1/project-context/work-items`
  - `PATCH /api/v1/project-context/work-items/:id`
  - `PUT /api/v1/project-context/focus`
- The existing `GET /api/v1/panel/context-pack` returns authoritative state plus the legacy expanded historical sections during migration.

- [ ] **Step 1: Write failing contract and route tests**

Assert Zod rejects missing namespace/provenance mutation fields, HTTP clients send the expected method/body, local routes require runtime authentication, and selecting `null` clears focus without blocking subsequent reads.

- [ ] **Step 2: Run focused backend tests and verify RED**

```bash
npm --prefix App/backend test -- src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/memory-client/tests/memos-sqlite-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts
```

Expected: failure because schemas, methods, and routes do not exist.

- [ ] **Step 3: Add exact Zod schemas**

Define `ProjectGoalSchema`, `ProjectWorkItemSchema`, `ProjectFactSchema`, `ProjectContextStateSchema`, and mutation schemas. Reuse existing namespace, provenance, memory-list, and ISO timestamp schemas. Export inferred types.

- [ ] **Step 4: Add Memory HTTP routes**

Route to the Task 2 facade. Use the same panel read/write authorization boundaries already used for memory governance. Ensure mutation idempotency uses the existing `requestId` mechanism.

- [ ] **Step 5: Add both Memory client implementations**

The HTTP client calls new endpoints and parses exact schemas. The embedded SQLite client calls the same `MemoryService` methods so local and remote modes have identical behavior.

- [ ] **Step 6: Extend local backend routes and panel service**

Proxy project-context state and mutations through authenticated runtime routes. Preserve `source`, `adapterId`, `requestId`, workspace path, and project ID from runtime context.

- [ ] **Step 7: Run backend tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 8: Commit the API unit**

```bash
git add Memory/src/server/http.ts App/backend/local-api-contracts/src/memory-runtime.ts App/backend/src/adapters/outbound/memory-client App/backend/src/services/panel-service.ts App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts App/backend/src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts
git commit -m "feat(api): expose project context governance"
```

---

### Task 5: Make Installed CLI Hooks Treat Project State As Authoritative

**Files:**
- Modify: `App/backend/src/adapters/outbound/skill-writer/templates/memmy-resume-hook.ts`
- Modify: `App/backend/src/adapters/outbound/skill-writer/templates/memmy-agent-protocol.test.ts`
- Modify: `App/backend/src/adapters/outbound/skill-writer/claude-code/tests/target.test.ts`
- Modify: `App/backend/src/adapters/outbound/skill-writer/codex/tests/target.test.ts`
- Modify: `App/backend/src/adapters/outbound/skill-writer/pi/tests/target.test.ts`

**Interfaces:**
- Consumes the extended `turns/start` output from Task 3.
- Injects two explicitly separated blocks:

```text
<memmy_project_context ...>confirmed current state</memmy_project_context>
<memmy_memory_context source="turn_start">supporting historical memories</memmy_memory_context>
```

- Saves `projectContextVersion` and combined `sourceMemoryIds` in turn state used by completion provenance.

- [ ] **Step 1: Write failing rendered-hook tests**

Execute rendered Claude Code, Codex, and Pi hook scripts against a fake Memory endpoint. Assert all three outputs contain the same project-context version before historical context. Return version 2 on a second prompt and assert the hook emits version 2, proving no authoritative cache.

Also assert an unavailable Memory service produces an explicit context-unavailable notice rather than stale project content.

- [ ] **Step 2: Run hook tests and verify RED**

```bash
npm --prefix App/backend test -- src/adapters/outbound/skill-writer/templates/memmy-agent-protocol.test.ts src/adapters/outbound/skill-writer/claude-code/tests/target.test.ts src/adapters/outbound/skill-writer/codex/tests/target.test.ts src/adapters/outbound/skill-writer/pi/tests/target.test.ts
```

Expected: failure because project context is not separately rendered or persisted.

- [ ] **Step 3: Update turn-start output rendering**

Read `started.projectContext` directly. Keep its authoritative marker intact and wrap only supplemental retrieval in `memmy_memory_context`. Do not convert candidates or legacy panel sections into authoritative prose.

- [ ] **Step 4: Update turn-state provenance**

Persist:

```ts
{
  projectContextVersion: turn.projectContext?.version,
  projectContextStatus: turn.projectContext?.status,
  sourceMemoryIds: turn.sourceMemoryIds
}
```

Forward these fields on turn completion.

- [ ] **Step 5: Run hook tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 6: Commit the hook unit**

```bash
git add App/backend/src/adapters/outbound/skill-writer/templates App/backend/src/adapters/outbound/skill-writer/claude-code/tests/target.test.ts App/backend/src/adapters/outbound/skill-writer/codex/tests/target.test.ts App/backend/src/adapters/outbound/skill-writer/pi/tests/target.test.ts
git commit -m "feat(hooks): inject authoritative project state"
```

---

### Task 6: Convert The Context Pack Dialog Into A Governance Surface

**Files:**
- Modify: `App/frontend/desktop/src/api/memory-runtime-client.ts`
- Modify: `App/frontend/desktop/src/pages/project-context-pack-dialog.tsx`
- Modify: `App/frontend/desktop/src/pages/context-pack-relation-graph.tsx`
- Modify: `App/frontend/desktop/src/i18n/messages.ts`
- Modify: `App/frontend/desktop/src/styles.css`
- Test: `App/frontend/desktop/src/pages/tests/project-context-pack-dialog.interaction.test.tsx`
- Test: `App/frontend/desktop/src/pages/tests/home-page-context-pack.interaction.test.tsx`

**Interfaces:**
- Consumes Task 4 local API schemas.
- Displays current goal, candidate goal, active focus, work-item list, confirmed facts, version, and evidence relations.
- Commands: approve/edit-and-approve/reject proposal; create work item; select/clear focus; update work-item status and next step.

- [ ] **Step 1: Write failing interaction tests**

Test from the user perspective:

```ts
it("does not label a candidate goal as current before approval", async () => {
  await renderDialog({ state: stateWithCandidate("Remember the project") });
  expect(screen.getByText("Pending proposal")).toBeTruthy();
  expect(screen.queryByText("Current goal: Remember the project")).toBeNull();
});

it("approves a proposal and refreshes the authoritative state", async () => {
  const approve = vi.fn().mockResolvedValue(activeGoalState());
  await renderDialog({ client: dialogClient({ approveProjectGoal: approve }) });
  click(buttonContaining("Approve"));
  await waitFor(() => expect(approve).toHaveBeenCalledOnce());
  expect(screen.getByText("Version 1")).toBeTruthy();
});

it("requires an explicit click to change focused work item", async () => {
  await renderDialog({ state: stateWithTwoWorkItems() });
  expect(selectFocus).not.toHaveBeenCalled();
  click(buttonContaining("Focus second item"));
  expect(selectFocus).toHaveBeenCalledWith("work-2");
});
```

Also cover clearing focus, editing long goal details, conflict state, failed mutation feedback, and preserving graph/detail navigation.

- [ ] **Step 2: Run UI tests and verify RED**

```bash
npm --prefix App/frontend/desktop test -- src/pages/tests/project-context-pack-dialog.interaction.test.tsx src/pages/tests/home-page-context-pack.interaction.test.tsx
```

Expected: failure because governance controls and client methods do not exist.

- [ ] **Step 3: Extend the frontend Memory client**

Add exact methods for Task 4 operations using the shared schemas. Keep all mutation state in the dialog and refresh from server responses; do not optimistically declare an unconfirmed goal active.

- [ ] **Step 4: Implement the dialog states**

Use unframed sections inside the modal, not nested cards. Provide explicit text controls for approval commands and a standard select/list control for work-item focus. Preserve existing memory details, history restore, copy Markdown, and relation graph behavior.

- [ ] **Step 5: Add bilingual copy and focused styling**

Add Chinese and English labels for goal status, proposal review, focus selection, conflicts, no-goal state, and non-blocking no-focus reminder. Keep current visual tokens and dialog radius conventions.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run the command from Step 2. Expected: all selected interaction tests pass.

- [ ] **Step 7: Run the desktop UI and verify visually**

Start the existing desktop frontend development server through the project process manager, open the context-pack dialog at desktop and narrow viewport sizes, and verify no overlapping text, preserved relation navigation, proposal status clarity, and manual focus controls.

- [ ] **Step 8: Commit the UI unit**

```bash
git add App/frontend/desktop/src/api/memory-runtime-client.ts App/frontend/desktop/src/pages/project-context-pack-dialog.tsx App/frontend/desktop/src/pages/context-pack-relation-graph.tsx App/frontend/desktop/src/i18n/messages.ts App/frontend/desktop/src/styles.css App/frontend/desktop/src/pages/tests/project-context-pack-dialog.interaction.test.tsx App/frontend/desktop/src/pages/tests/home-page-context-pack.interaction.test.tsx
git commit -m "feat(ui): govern project context packs"
```

---

### Task 7: Verify Cross-CLI Persistence End To End

**Files:**
- Create: `tests/smoke/project-context-pack-smoke.test.ts`
- Modify: `README.zh-CN.md`
- Modify: `README.md`

**Interfaces:**
- Uses the public Memory HTTP service and rendered Claude Code, Codex, and Pi hooks.
- Proves the completion criterion from the design with one real workspace namespace.

- [ ] **Step 1: Write the failing smoke scenario**

The smoke test must:

1. start an isolated Memory service/database;
2. create and approve a long primary goal and a hard constraint;
3. create two work items and focus the first;
4. invoke the three rendered hook modes with unrelated prompts;
5. assert identical namespace/version and stable authoritative content;
6. focus the second item;
7. invoke another prompt and assert the goal is unchanged while focus changes;
8. create but do not approve a revision and assert it is absent;
9. approve the revision and assert it appears on the next prompt with history retained.

- [ ] **Step 2: Run the smoke test and verify RED**

```bash
npx vitest run tests/smoke/project-context-pack-smoke.test.ts
```

Expected: failure until the complete API/hook chain is wired.

- [ ] **Step 3: Fix only integration gaps revealed by the smoke test**

Do not add new behavior. Correct contract mismatches, missing provenance fields, or namespace propagation errors in the owning modules from Tasks 1-6.

- [ ] **Step 4: Run the smoke test and verify GREEN**

Run the command from Step 2. Expected: one passing end-to-end scenario with all three hook modes.

- [ ] **Step 5: Update user-facing documentation**

Document:

- confirmed project goal versus ordinary Memory;
- long goal detail versus stable per-turn summary;
- proposal approval requirement;
- one primary goal with multiple manually selected work items;
- no-focus behavior;
- cross-CLI fixed injection.

Do not claim automatic goal activation.

- [ ] **Step 6: Run targeted regression suites**

```bash
npm --prefix Memory test -- tests/repository/project-context-repository.test.ts tests/service/project-context/project-context-service.test.ts tests/service/session/turn-capture.test.ts tests/contract/memory-rest-service.test.ts
npm --prefix App/backend test -- src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/memory-client/tests/memos-sqlite-memory-client.test.ts src/adapters/outbound/skill-writer/templates/memmy-agent-protocol.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts
npm --prefix App/frontend/desktop test -- src/pages/tests/project-context-pack-dialog.interaction.test.tsx src/pages/tests/home-page-context-pack.interaction.test.tsx
npx vitest run tests/smoke/project-context-pack-smoke.test.ts
```

Expected: all selected suites pass with zero failures.

- [ ] **Step 7: Typecheck affected packages**

```bash
npm --prefix Memory run typecheck
npm --prefix App/backend run typecheck
npm --prefix App/frontend/desktop run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit verification and documentation**

```bash
git add tests/smoke/project-context-pack-smoke.test.ts README.md README.zh-CN.md
git commit -m "test: verify project context across cli agents"
```
