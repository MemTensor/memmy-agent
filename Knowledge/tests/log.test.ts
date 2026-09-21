import { expect, it, vi } from "vitest";
import {
  describeKnowledgeRouteError,
  knowledgeLog,
  sanitizeKnowledgeLog,
} from "../src/log.js";
import { KnowledgeError } from "../src/types.js";

it("keeps only diagnostic fields and strips URL query strings", () => {
  expect(
    sanitizeKnowledgeLog({
      hop: "cloud",
      action: "request",
      path: "https://cloud.example/api/knowledge/bases/owned/files?token=secret",
      message: "x".repeat(400),
      name: "doc.pdf",
      status: 413,
      bodyBytes: 24_524_592,
    }),
  ).toEqual({
    hop: "cloud",
    action: "request",
    path: "/api/knowledge/bases/owned/files",
    message: "x".repeat(300),
    name: "doc.pdf",
    status: 413,
    bodyBytes: 24_524_592,
  });
});

it("maps Fastify oversized bodies to a local 413 without leaking the raw parser error", () => {
  const described = describeKnowledgeRouteError({
    code: "FST_ERR_CTP_BODY_TOO_LARGE",
    statusCode: 413,
    message: "Request body is too large",
  });
  expect(described).toEqual({
    status: 413,
    message: "本地上传请求体过大",
    kind: "body-too-large",
  });
  expect(describeKnowledgeRouteError(new KnowledgeError("目录参数无效", 400))).toEqual({
    status: 400,
    message: "目录参数无效",
    kind: "knowledge",
  });
});

it("does not write file content or credentials when logging", () => {
  const dumped: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    dumped.push(JSON.stringify(args));
  });
  knowledgeLog({
    hop: "ui",
    action: "upload-file",
    name: "doc.pdf",
    bytes: 18393442,
    message: "本地上传请求体过大",
  });
  expect(dumped.join("\n")).toContain("[knowledge]");
  expect(dumped.join("\n")).toContain("18393442");
  expect(dumped.join("\n")).not.toContain("Authorization");
  expect(dumped.join("\n")).not.toContain("content");
  spy.mockRestore();
});
