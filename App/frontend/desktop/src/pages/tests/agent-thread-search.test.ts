// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { collectThreadSearchHits, findThreadSearchOffsets } from "../agent-thread-search.js";

describe("thread search", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("matches literal text case-insensitively", () => {
    expect(findThreadSearchOffsets("Price is $5 (five). price!", "price")).toEqual([[0, 5], [20, 25]]);
    expect(findThreadSearchOffsets("a+b a+b", "a+b")).toEqual([[0, 3], [4, 7]]);
    expect(findThreadSearchOffsets("anything", "   ")).toEqual([]);
  });

  it("only searches message bodies and skips controls, code widgets and inputs", () => {
    document.body.innerHTML = `
      <div data-agent-message-id="u1">
        <div data-agent-search-root>Deploy the <strong>deploy</strong> script</div>
        <button>deploy</button>
      </div>
      <div data-agent-message-id="a1">
        <div data-agent-search-root>
          <p>Deployment finished</p>
          <button type="button">Copy deploy log</button>
          <span data-chat-search-skip>deploy timestamp</span>
          <textarea>deploy</textarea>
        </div>
      </div>
      <p>deploy outside a message</p>
    `;

    const hits = collectThreadSearchHits(document.body, "DEPLOY");

    expect(hits.map((hit) => [hit.messageId, hit.range.toString()])).toEqual([
      ["u1", "Deploy"],
      ["u1", "deploy"],
      ["a1", "Deploy"],
    ]);
  });

  it("stops collecting hits at the limit", () => {
    document.body.innerHTML = `<div data-agent-search-root>${"a ".repeat(50)}</div><div data-agent-search-root>a a</div>`;

    expect(collectThreadSearchHits(document.body, "a", 10)).toHaveLength(10);
  });

  it("returns no hits for an empty query or a missing root", () => {
    document.body.innerHTML = `<div data-agent-search-root>text</div>`;
    expect(collectThreadSearchHits(document.body, "")).toEqual([]);
    expect(collectThreadSearchHits(null, "text")).toEqual([]);
  });
});
