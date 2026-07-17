import { describe, expect, it } from "vitest";
import {
  DagPatchValidationError,
  normalizeDagTaskTransition,
  sanitizeSourceRefs,
  validateDagPatch,
} from "../../src/session-dag/patch-schema.js";
import type { DagBuilderContext, DagPatch } from "../../src/session-dag/types.js";

describe("DAG patch schema", () => {
  it("accepts fixed add/update/edge operations and sanitizes controlled fields", () => {
    const patch = validateDagPatch(
      {
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "subtask",
            status: "active",
            title: "修改 DAG 方案",
            summary: "调整 source_refs 的定义",
            importance: 88.4,
            detail_json: {
              commands: ["npm test"],
              files: [".docs/dag.md"],
              reason: "drop",
              unsupported: "drop",
            },
            source_refs: [
              { type: "file", path: ".docs/dag.md", title: "DAG 方案", summary: "drop", hash: "drop" },
              { type: "text_message", title: "not allowed", message_ids: ["m1"] },
            ],
          },
          {
            op: "update_node",
            node_id: "n_existing",
            status: "done",
            importance: 90,
          },
          {
            op: "update_node",
            node_id: "n_decision",
            detail_json: {
              basis: ["保留 source_refs 外部证据"],
              impact: "drop",
            },
          },
          {
            op: "add_edge",
            source_id: "n_existing",
            target_id: "n0",
            type: "continues",
          },
        ],
      },
      { contextNodeKinds: { n_existing: "subtask", n_decision: "decision" } },
    );

    expect(patch.ops[0]).toMatchObject({
      op: "add_node",
      importance: 88,
      detail_json: { commands: ["npm test"] },
      source_refs: [{ type: "file", path: ".docs/dag.md", title: "DAG 方案" }],
    });
    expect(patch.ops[1]).toMatchObject({ op: "update_node", node_id: "n_existing", status: "done" });
    expect(patch.ops[2]).toMatchObject({ op: "update_node", node_id: "n_decision", detail_json: { basis: ["保留 source_refs 外部证据"] } });
    expect(patch.ops[3]).toMatchObject({ op: "add_edge", source_id: "n_existing", target_id: "n0", type: "continues" });
  });

  it("rejects unsupported top-level patch fields and unknown op fields", () => {
    expect(() =>
      validateDagPatch({
        unexpected: "not allowed",
        ops: [],
      }),
    ).toThrow(/unsupported top-level field unexpected/);

    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "delete_node",
            node_id: "n1",
          },
        ],
      }),
    ).toThrow(DagPatchValidationError);

    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "task",
            summary: "summary",
            importance: 50,
            label: "too heavy",
          },
        ],
      }),
    ).toThrow(/unsupported field label/);
  });

  it("rejects unknown add_edge fields", () => {
    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "add_edge",
              source_id: "n1",
              target_id: "n2",
              type: "continues",
              label: "not allowed",
            },
          ],
        },
        { contextNodeKinds: { n1: "task", n2: "task" } },
      ),
    ).toThrow(/unsupported field label/);
  });

  it("requires add_node summary to be non-empty", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "task",
            summary: "",
            importance: 50,
          },
        ],
      }),
    ).toThrow(/summary must be a non-empty string/);
  });

  it("requires add_node temp_id to use the current temporary id format", () => {
    for (const tempId of ["<tmp_1>", "<tmp_0>", "tmp_1", "0", "n01", "n_123", "semantic_name"]) {
      expect(() =>
        validateDagPatch({
          ops: [
            {
              op: "add_node",
              temp_id: tempId,
              kind: "task",
              status: "active",
              title: "task",
              summary: "summary",
              importance: 50,
            },
          ],
        }),
      ).toThrow(/temp_id must be n0/);
    }
  });

  it("requires add_node temp_id to be continuous in add_node order", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n1",
            kind: "task",
            status: "active",
            title: "task",
            summary: "summary",
            importance: 50,
          },
        ],
      }),
    ).toThrow(/op 0 temp_id must be n0/);

    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "task",
            summary: "summary",
            importance: 50,
          },
          {
            op: "add_node",
            temp_id: "n2",
            kind: "task",
            status: "active",
            title: "next task",
            summary: "next summary",
            importance: 50,
          },
        ],
      }),
    ).toThrow(/op 1 temp_id must be n1/);
  });

  it("limits newly added task count and status while allowing later task status updates", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "task",
            summary: "summary",
            importance: 80,
          },
          {
            op: "add_node",
            temp_id: "n1",
            kind: "task",
            status: "blocked",
            title: "blocked task",
            summary: "blocked summary",
            importance: 80,
          },
        ],
      }),
    ).toThrow(/at most one task/);

    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "done",
            title: "task",
            summary: "summary",
            importance: 80,
          },
        ],
      }),
    ).toThrow(/task add_node status must be active or blocked/);

    const patch = validateDagPatch(
      {
        ops: [{ op: "update_node", node_id: "n_task", status: "done" }],
      },
      { contextNodeKinds: { n_task: "task" } },
    );

    expect(patch.ops[0]).toMatchObject({ op: "update_node", node_id: "n_task", status: "done" });
  });

  it("requires existing node references to be in builder context", () => {
    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "update_node",
              node_id: "n_missing",
              status: "done",
            },
          ],
        },
        { contextNodeKinds: { n_known: "task" } },
      ),
    ).toThrow(/outside builder context/);
  });

  it("rejects isolated added subtask", () => {
    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "add_node",
              temp_id: "n0",
              kind: "subtask",
              status: "active",
              title: "孤立子任务",
              summary: "没有边接回任务",
              importance: 70,
            },
          ],
        },
        { contextNodeKinds: { n_task: "task" } },
      ),
    ).toThrow(/DAG patch add_node temp_id n0 kind subtask must be connected by add_edge/);
  });

  it("accepts added subtask connected from existing node", () => {
    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "add_node",
              temp_id: "n0",
              kind: "subtask",
              status: "active",
              title: "继续子任务",
              summary: "通过边接回已有子任务",
              importance: 70,
            },
            { op: "add_edge", source_id: "n_existing", target_id: "n0", type: "continues" },
          ],
        },
        { contextNodeKinds: { n_existing: "subtask" } },
      ),
    ).not.toThrow();
  });

  it("accepts new task with connected subtask", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "新任务",
            summary: "新增任务根节点",
            importance: 90,
          },
          {
            op: "add_node",
            temp_id: "n1",
            kind: "subtask",
            status: "done",
            title: "完成子任务",
            summary: "挂在新任务下",
            importance: 75,
          },
          { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
        ],
      }),
    ).not.toThrow();
  });

  it("normalizes an omitted task transition to done and continues after completed work", () => {
    const context = taskContext("active", [contextChild("done-child", "done")]);
    const parsed = validateDagPatch(
      {
        ops: [
          taskAdd("n0"),
          {
            op: "add_node",
            temp_id: "n1",
            kind: "subtask",
            status: "done",
            title: "完成新任务",
            summary: "新任务已有结果",
            importance: 70,
          },
          { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
        ],
      },
      { contextNodeKinds: contextKinds(context) },
    );

    expect(normalizeDagTaskTransition(parsed, context)).toEqual({
      ops: [
        { op: "update_node", node_id: "root-task", status: "done" },
        expect.objectContaining({ op: "add_node", temp_id: "n0", kind: "task" }),
        expect.objectContaining({ op: "add_node", temp_id: "n1", kind: "subtask" }),
        { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
        { op: "add_edge", source_id: "root-task", target_id: "n0", type: "continues" },
      ],
    });
  });

  it("normalizes a switch with open descendants to frozen and supersedes", () => {
    const context = taskContext("active", [contextChild("open-child", "blocked")]);
    const parsed = validateDagPatch(
      { ops: [taskAdd("n0")] },
      { contextNodeKinds: contextKinds(context) },
    );

    expect(normalizeDagTaskTransition(parsed, context).ops).toEqual([
      { op: "update_node", node_id: "root-task", status: "frozen" },
      expect.objectContaining({ op: "add_node", temp_id: "n0", kind: "task" }),
      { op: "add_edge", source_id: "root-task", target_id: "n0", type: "supersedes" },
    ]);
  });

  it.each([
    {
      name: "done status fills continues edge",
      ops: [{ op: "update_node", node_id: "root-task", status: "done" }, taskAdd("n0")],
      expectedStatus: "done",
      expectedEdge: "continues",
    },
    {
      name: "frozen status fills supersedes edge",
      ops: [{ op: "update_node", node_id: "root-task", status: "frozen" }, taskAdd("n0")],
      expectedStatus: "frozen",
      expectedEdge: "supersedes",
    },
    {
      name: "continues edge fills done status",
      ops: [taskAdd("n0"), { op: "add_edge", source_id: "root-task", target_id: "n0", type: "continues" }],
      expectedStatus: "done",
      expectedEdge: "continues",
    },
    {
      name: "supersedes edge fills frozen status",
      ops: [taskAdd("n0"), { op: "add_edge", source_id: "root-task", target_id: "n0", type: "supersedes" }],
      expectedStatus: "frozen",
      expectedEdge: "supersedes",
    },
  ])("$name", ({ ops, expectedStatus, expectedEdge }) => {
    const context = taskContext("active");
    const parsed = validateDagPatch(
      { ops },
      { contextNodeKinds: contextKinds(context) },
    );
    const normalized = normalizeDagTaskTransition(parsed, context);

    expect(normalized.ops[0]).toEqual({ op: "update_node", node_id: "root-task", status: expectedStatus });
    expect(normalized.ops.at(-1)).toEqual({
      op: "add_edge",
      source_id: "root-task",
      target_id: "n0",
      type: expectedEdge,
    });
  });

  it.each([
    {
      name: "done with supersedes",
      ops: [
        { op: "update_node", node_id: "root-task", status: "done" },
        taskAdd("n0"),
        { op: "add_edge", source_id: "root-task", target_id: "n0", type: "supersedes" },
      ],
      error: /conflicts with edge type supersedes/,
    },
    {
      name: "frozen with continues",
      ops: [
        { op: "update_node", node_id: "root-task", status: "frozen" },
        taskAdd("n0"),
        { op: "add_edge", source_id: "root-task", target_id: "n0", type: "continues" },
      ],
      error: /conflicts with edge type continues/,
    },
    {
      name: "wrong transition source",
      ops: [taskAdd("n0"), { op: "add_edge", source_id: "done-child", target_id: "n0", type: "continues" }],
      error: /current root_task_id directly/,
    },
    {
      name: "invalid task edge type",
      ops: [taskAdd("n0"), { op: "add_edge", source_id: "root-task", target_id: "n0", type: "decomposes" }],
      error: /edge type must be continues or supersedes/,
    },
  ])("rejects $name", ({ ops, error }) => {
    const context = taskContext("active", [contextChild("done-child", "done")]);
    const parsed = validateDagPatch(
      { ops },
      { contextNodeKinds: contextKinds(context) },
    );

    expect(() => normalizeDagTaskTransition(parsed, context)).toThrow(error);
  });

  it("does not inject a root update or task edge when no task is added", () => {
    const context = taskContext("active", [contextChild("done-child", "done")]);
    const parsed = validateDagPatch(
      { ops: [{ op: "update_node", node_id: "done-child", summary: "补充结果" }] },
      { contextNodeKinds: contextKinds(context) },
    );

    expect(normalizeDagTaskTransition(parsed, context)).toBe(parsed);
  });

  it("rejects chained new subtasks when chain root is isolated", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "subtask",
            status: "active",
            title: "孤立链起点",
            summary: "没有接入任务根",
            importance: 70,
          },
          {
            op: "add_node",
            temp_id: "n1",
            kind: "subtask",
            status: "active",
            title: "孤立链后继",
            summary: "只接到孤立起点",
            importance: 70,
          },
          { op: "add_edge", source_id: "n0", target_id: "n1", type: "continues" },
        ],
      }),
    ).toThrow(/DAG patch add_node temp_id n0 kind subtask must be connected by add_edge/);
  });

  it("rejects isolated added decision", () => {
    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "add_node",
              temp_id: "n0",
              kind: "decision",
              status: "done",
              title: "孤立结论",
              summary: "没有边接回任务",
              importance: 80,
            },
          ],
        },
        { contextNodeKinds: { n_task: "task" } },
      ),
    ).toThrow(/DAG patch add_node temp_id n0 kind decision must be connected by add_edge/);
  });

  it("accepts added decision connected from existing subtask", () => {
    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "add_node",
              temp_id: "n0",
              kind: "decision",
              status: "done",
              title: "有效结论",
              summary: "接在已有子任务后",
              importance: 80,
            },
            { op: "add_edge", source_id: "n_existing", target_id: "n0", type: "continues" },
          ],
        },
        { contextNodeKinds: { n_existing: "subtask" } },
      ),
    ).not.toThrow();
  });

  it("rejects update_node references to same-patch temporary ids", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "task",
            summary: "summary",
            importance: 50,
          },
          {
            op: "update_node",
            node_id: "n0",
            status: "done",
          },
        ],
      }),
    ).toThrow(/update_node\.node_id cannot reference temp_id n0/);
  });

  it("keeps source refs to file, artifact and url only", () => {
    const refs = sanitizeSourceRefs(
      [
        { type: "file", title: "文件", path: "src/a.ts", line: 3, summary: "drop", hash: "drop" },
        { type: "artifact", title: "报告", artifact_path: "reports/out.txt", hash: "abc" },
        { type: "url", title: "论文", url: "https://example.com/paper", summary: "drop" },
        { type: "file", title: "缺路径" },
        { type: "tool_call_pair", title: "工具", tool_call_id: "call_1" },
      ],
      "turn-1",
    );

    expect(refs).toEqual([
      { type: "file", title: "文件", path: "src/a.ts", line: 3, turn_id: "turn-1" },
      { type: "artifact", title: "报告", artifact_path: "reports/out.txt", turn_id: "turn-1" },
      { type: "url", title: "论文", url: "https://example.com/paper", turn_id: "turn-1" },
    ]);
  });

  it("rejects source refs on task nodes", () => {
    expect(() =>
      validateDagPatch({
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "目标",
            summary: "目标摘要",
            importance: 80,
            source_refs: [{ type: "url", title: "外部资料", url: "https://example.com" }],
          },
        ],
      }),
    ).toThrow(/task nodes cannot include source_refs/);

    expect(() =>
      validateDagPatch(
        {
          ops: [
            {
              op: "update_node",
              node_id: "n_task",
              source_refs: [{ type: "file", title: "文件", path: "a.ts" }],
            },
          ],
        },
        { contextNodeKinds: { n_task: "task" } },
      ),
    ).toThrow(/task nodes cannot include source_refs/);
  });
});

function taskAdd(tempId: string): DagPatch["ops"][number] {
  return {
    op: "add_node",
    temp_id: tempId,
    kind: "task",
    status: "active",
    title: "新任务",
    summary: "切换到新的任务阶段",
    importance: 90,
  };
}

function contextChild(id: string, status: "active" | "done" | "failed" | "blocked" | "frozen"): DagBuilderContext["nodes"][number] {
  return {
    id,
    kind: "subtask",
    status,
    title: id,
    summary: `${id} summary`,
    importance: 70,
    created_by: "llm_patch",
    updated_by: "llm_patch",
    source_refs: [],
    updated_turn_id: "turn-1",
    first_message_index: 0,
    last_message_index: 2,
  };
}

function taskContext(
  status: "active" | "done" | "failed" | "blocked" | "frozen",
  children: DagBuilderContext["nodes"] = [],
): DagBuilderContext {
  return {
    root_task_id: "root-task",
    nodes: [
      {
        id: "root-task",
        kind: "task",
        status,
        title: "旧任务",
        summary: "当前任务",
        importance: 90,
        created_by: "llm_patch",
        updated_by: "llm_patch",
        source_refs: [],
        updated_turn_id: "turn-1",
        first_message_index: 0,
        last_message_index: 2,
      },
      ...children,
    ],
    edges: children.map((child) => ({ source_id: "root-task", target_id: child.id, type: "decomposes" })),
    active_path: ["root-task", ...children.map((child) => child.id)],
    active_path_edges: [],
  };
}

function contextKinds(context: DagBuilderContext): Record<string, DagBuilderContext["nodes"][number]["kind"]> {
  return Object.fromEntries(context.nodes.map((node) => [node.id, node.kind]));
}
