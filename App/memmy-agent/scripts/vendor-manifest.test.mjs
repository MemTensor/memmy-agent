import assert from "node:assert/strict";
import test from "node:test";
import { vendoredManifest } from "./vendor-manifest.mjs";

const versions = new Map([["@memmy/agent-source-core", "0.0.0"], ["@memmy/local-api-contracts", "0.0.0"]]);

test("asks for a vendored sibling by version instead of a repository path", () => {
  const manifest = {
    name: "@memmy/local-api-contracts",
    version: "0.0.0",
    dependencies: { zod: "^4.4.3", "@memmy/agent-source-core": "file:../../../Memory/AgentSourceCore" },
  };
  const vendored = vendoredManifest(manifest, versions);
  assert.deepEqual(vendored.dependencies, { zod: "^4.4.3", "@memmy/agent-source-core": "0.0.0" });
  assert.equal(vendored.name, manifest.name);
  // The checkout keeps its repository-relative link.
  assert.equal(manifest.dependencies["@memmy/agent-source-core"], "file:../../../Memory/AgentSourceCore");
});

test("returns the same manifest when nothing points outside the tarball", () => {
  for (const manifest of [{ name: "@memmy/knowledge" }, { name: "@memmy/migrations", dependencies: { yaml: "^2.8.2" } }]) {
    assert.equal(vendoredManifest(manifest, versions), manifest);
  }
});

test("rejects a local dependency that the npm package does not vendor", () => {
  const manifest = { name: "@memmy/local-api-contracts", dependencies: { "@memmy/memory": "file:../../../Memory" } };
  assert.throws(() => vendoredManifest(manifest, versions), {
    message: "@memmy/local-api-contracts depends on @memmy/memory (file:../../../Memory), which is not vendored into the npm package",
  });
});
