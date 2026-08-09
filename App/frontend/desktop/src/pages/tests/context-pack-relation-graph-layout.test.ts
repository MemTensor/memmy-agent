import { describe, expect, it } from "vitest";
import type { ProjectContextPackOutput } from "@memmy/local-api-contracts";
import { layoutMemoryRelationGraph } from "../context-pack-relation-graph-layout.js";

describe("layoutMemoryRelationGraph", () => {
  it("places memory layers in stable columns and rows", () => {
    const layout = layoutMemoryRelationGraph(graph(), "memory-l2-a");
    const l1 = layout.nodes.find((node) => node.id === "memory-l1");
    const l2a = layout.nodes.find((node) => node.id === "memory-l2-a");
    const l2b = layout.nodes.find((node) => node.id === "memory-l2-b");
    const skill = layout.nodes.find((node) => node.id === "memory-skill");

    expect(l2a?.position.x).toBeGreaterThan(l1?.position.x ?? 0);
    expect(skill?.position.x).toBeGreaterThan(l2a?.position.x ?? 0);
    expect(l2b?.position.x).toBe(l2a?.position.x);
    expect(l2b?.position.y).toBeGreaterThan(l2a?.position.y ?? 0);
    expect(l2a?.data.anchor).toBe(true);
    expect(skill?.data.external).toBe(true);
  });

  it("keeps typed relations and drops edges whose nodes are absent", () => {
    const layout = layoutMemoryRelationGraph(graph(), "memory-l2-a");

    expect(layout.edges).toContainEqual(expect.objectContaining({
      source: "memory-l1",
      target: "memory-l2-a",
      label: "source",
      className: "context-pack-relation-edge context-pack-relation-edge--source"
    }));
    expect(layout.edges).toContainEqual(expect.objectContaining({
      source: "memory-l2-a",
      target: "memory-l2-b",
      label: "supersedes",
      style: expect.objectContaining({ strokeDasharray: "5 4" })
    }));
    expect(layout.edges.some((edge) => edge.target === "missing-memory")).toBe(false);
  });
});

function graph(): ProjectContextPackOutput["graph"] {
  return {
    nodes: [
      node("memory-l1", "L1"),
      node("memory-l2-a", "L2"),
      node("memory-l2-b", "L2"),
      { ...node("memory-skill", "Skill"), external: true }
    ],
    edges: [
      { sourceId: "memory-l1", targetId: "memory-l2-a", relation: "source" },
      { sourceId: "memory-l2-a", targetId: "memory-l2-b", relation: "supersedes", reason: "new evidence" },
      { sourceId: "memory-l2-a", targetId: "missing-memory", relation: "source" }
    ]
  };
}

function node(id: string, memoryLayer: "L1" | "L2" | "L3" | "Skill") {
  return {
    id,
    kind: memoryLayer === "Skill" ? "skill" as const : "policy" as const,
    memoryLayer,
    status: "activated" as const,
    title: id,
    summary: "",
    tags: [],
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    version: 1
  };
}
