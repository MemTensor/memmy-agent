import { expect, it } from "vitest";
import type { KnowledgeFolder } from "../src/types.js";
import {
  descendantFolderIds,
  folderBreadcrumb,
  folderChain,
  folderDepth,
  folderLocationPath,
} from "../src/ui/folder-path.js";

function byId(...folders: KnowledgeFolder[]) {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

it("walks an acyclic path from a nested folder to the root", () => {
  const folders = byId(
    { id: "a", parentId: "", name: "资料" },
    { id: "b", parentId: "a", name: "历史稿" },
    { id: "c", parentId: "b", name: "备份" },
  );
  expect(folderChain(folders, "c").map((folder) => folder.id)).toEqual([
    "c",
    "b",
    "a",
  ]);
  expect(folderLocationPath(folders, "c")).toBe("资料 / 历史稿 / 备份 /");
  expect(folderBreadcrumb(folders, "c").map((folder) => folder.name)).toEqual([
    "资料",
    "历史稿",
    "备份",
  ]);
  expect(folderDepth(folders, "c")).toBe(3);
  expect(folderDepth(folders, "")).toBe(0);
});

it("stops when parent links form a cycle instead of walking forever", () => {
  const folders = byId(
    { id: "a", parentId: "b", name: "属性资料" },
    { id: "b", parentId: "a", name: "历史稿" },
    { id: "c", parentId: "c", name: "自指目录" },
  );
  expect(folderChain(folders, "a").map((folder) => folder.id)).toEqual([
    "a",
    "b",
  ]);
  expect(folderLocationPath(folders, "a")).toBe("历史稿 / 属性资料 /");
  expect(folderBreadcrumb(folders, "a").map((folder) => folder.id)).toEqual([
    "b",
    "a",
  ]);
  expect(folderChain(folders, "c").map((folder) => folder.id)).toEqual(["c"]);
  expect(folderDepth(folders, "c")).toBe(1);
  expect(folderLocationPath(folders, "")).toBe("");
  expect(folderLocationPath(folders, "missing")).toBe("");
});

it("collects a nested folder tree in linear time and stops on cycles", () => {
  const folders: KnowledgeFolder[] = [
    { id: "lenovo", parentId: "", name: "联想" },
    { id: "docs", parentId: "lenovo", name: "知识库资料" },
    { id: "attr", parentId: "lenovo", name: "属性记忆能力更新" },
  ];
  expect(descendantFolderIds(folders, ["lenovo"]).sort()).toEqual([
    "attr",
    "docs",
    "lenovo",
  ]);
  expect(descendantFolderIds(folders, ["docs"])).toEqual(["docs"]);

  const chain: KnowledgeFolder[] = [];
  for (let index = 0; index < 8_000; index += 1) {
    chain.push({
      id: `n${index}`,
      parentId: index === 0 ? "" : `n${index - 1}`,
      name: `n${index}`,
    });
  }
  const started = Date.now();
  expect(descendantFolderIds(chain, ["n0"])).toHaveLength(8_000);
  expect(Date.now() - started).toBeLessThan(200);

  const cyclic: KnowledgeFolder[] = [
    { id: "a", parentId: "b", name: "A" },
    { id: "b", parentId: "a", name: "B" },
  ];
  expect(descendantFolderIds(cyclic, ["a"]).sort()).toEqual(["a", "b"]);
});
