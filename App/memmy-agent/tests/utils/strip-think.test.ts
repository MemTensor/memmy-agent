import { describe, expect, it } from "vitest";
import { extractReasoning, extractThink, stripThink } from "../../src/utils/helpers.js";

describe("stripThink well-formed thinking tags", () => {
  it("strips a closed thought tag", () => {
    expect(stripThink("Hello <thought>reasoning</thought> World")).toBe("Hello  World");
  });

  it("strips an unclosed trailing thought tag", () => {
    expect(stripThink("<thought>ongoing...")).toBe("");
  });

  it("strips a multiline thought tag", () => {
    expect(stripThink("<thought>\nline1\nline2\n</thought>End")).toBe("End");
  });

  it("strips a tag with nested angle brackets", () => {
    expect(stripThink("<thought>a < 3 and b > 2</thought>result")).toBe("result");
  });

  it("strips multiple tag blocks", () => {
    expect(stripThink("A<thought>x</thought>B<thought>y</thought>C")).toBe("ABC");
  });

  it("strips tags with only whitespace inside", () => {
    expect(stripThink("before<thought>  </thought>after")).toBe("beforeafter");
  });

  it("preserves self-closing thought tags", () => {
    expect(stripThink("<thought/>some text")).toBe("<thought/>some text");
  });

  it("preserves normal text", () => {
    expect(stripThink("Just normal text")).toBe("Just normal text");
  });

  it("handles empty strings", () => {
    expect(stripThink("")).toBe("");
  });
});

describe("stripThink false positives", () => {
  it("preserves backticked think tags", () => {
    const text = "*Think Stripping:* A new utility to strip `<think>` tags from output.";
    expect(stripThink(text)).toBe(text);
  });

  it("preserves prose think tags", () => {
    const text = "The model emits <think> at the start of its response.";
    expect(stripThink(text)).toBe(text);
  });

  it("preserves think tags inside code blocks", () => {
    const text = 'Example:\n```\ntext = re.sub(r"<think>[\\s\\S]*", "", text)\n```\nDone.';
    expect(stripThink(text)).toBe(text);
  });

  it("preserves backticked thought tags", () => {
    const text = "Gemma 4 uses `<thought>` blocks for reasoning.";
    expect(stripThink(text)).toBe(text);
  });

  it("still strips unclosed prefix think tags", () => {
    expect(stripThink("<think>reasoning without closing")).toBe("");
  });

  it("still strips unclosed prefix think tags with whitespace", () => {
    expect(stripThink("  <think>reasoning...")).toBe("");
  });

  it("still strips unclosed prefix thought tags", () => {
    expect(stripThink("<thought>reasoning without closing")).toBe("");
  });
});

describe("stripThink malformed leaks", () => {
  it("cleans malformed Chinese think tags without greater-than", () => {
    expect(stripThink("<think广场照明灯目前绑定在'照明灯'策略下")).toBe(
      "广场照明灯目前绑定在'照明灯'策略下",
    );
  });

  it("cleans malformed English think tags without greater-than", () => {
    expect(stripThink("<think The fountain opens at 09:00")).toBe("The fountain opens at 09:00");
  });

  it("cleans malformed thought tags without greater-than", () => {
    expect(stripThink("<thought广场照明灯")).toBe("广场照明灯");
  });

  it("preserves thinker tags", () => {
    expect(stripThink("<thinker>content</thinker>")).toBe("<thinker>content</thinker>");
  });

  it("preserves self-closing think and thought tags", () => {
    expect(stripThink("<think/>ok")).toBe("<think/>ok");
    expect(stripThink("<thought/>ok")).toBe("<thought/>ok");
  });

  it("strips orphan closing think tags at the end", () => {
    expect(stripThink("answer</think>")).toBe("answer");
  });

  it("strips orphan closing think tags at the start", () => {
    expect(stripThink("</think>answer")).toBe("answer");
  });

  it("strips channel markers at the start", () => {
    expect(stripThink("<channel|>喷泉策略：09:00 开启")).toBe("喷泉策略：09:00 开启");
    expect(stripThink("<|channel|>answer")).toBe("answer");
  });

  it("strips partial trailing think tags after visible text", () => {
    expect(stripThink("<thi")).toBe("");
    expect(stripThink("Hello <thi")).toBe("Hello");
    expect(stripThink("喷泉策略说明 <thin")).toBe("喷泉策略说明");
    expect(stripThink("answer <thought")).toBe("answer");
    expect(stripThink("answer <think>")).toBe("answer");
  });

  it("strips orphan closing tags left after extracted thinking blocks", () => {
    expect(extractThink("<think>hidden</think></think>Visible")).toEqual(["hidden", "Visible"]);
  });

  it("strips partial trailing channel markers after visible text", () => {
    expect(stripThink("喷泉策略说明 <|chan")).toBe("喷泉策略说明");
    expect(stripThink("answer <channel")).toBe("answer");
    expect(stripThink("answer <|channel|>")).toBe("answer");
  });
});

describe("stripThink Claude artifact tag leaks", () => {
  it("strips full antThinking blocks with their content", () => {
    expect(stripThink("<antThinking>hidden plan</antThinking>Visible")).toBe("Visible");
  });

  it("strips orphan closing antThinking tags at the end", () => {
    expect(stripThink("表格已生成：\n</antThinking>")).toBe("表格已生成：");
  });

  it("strips typo'd orphan ant tags on their own line", () => {
    expect(stripThink("现在生成第一张图——**早晨到上午**：\n</antThthinking>")).toBe("现在生成第一张图——**早晨到上午**：");
  });

  it("strips partial trailing ant tags cut mid-stream", () => {
    expect(stripThink("现在生成第一张图：\n</antThthinking")).toBe("现在生成第一张图：");
  });

  it("preserves backticked ant tag mentions in prose", () => {
    const text = "Claude 会用 `<antThinking>` 标签包裹思考。";
    expect(stripThink(text)).toBe(text);
  });
});

describe("stripThink conservative preservation", () => {
  it("preserves dash tag-name variants", () => {
    expect(stripThink("<think-foo>bar</think-foo>")).toBe("<think-foo>bar</think-foo>");
  });

  it("preserves underscore tag-name variants", () => {
    expect(stripThink("<think_foo>bar</think_foo>")).toBe("<think_foo>bar</think_foo>");
  });

  it("preserves numeric tag-name variants", () => {
    expect(stripThink("<think1>bar</think1>")).toBe("<think1>bar</think1>");
  });

  it("preserves namespaced tag-name variants", () => {
    expect(stripThink("<think:foo>bar</think:foo>")).toBe("<think:foo>bar</think:foo>");
  });

  it("preserves literal closing think tags in prose", () => {
    const text = "Use `</think>` to close a thinking block.";
    expect(stripThink(text)).toBe(text);
  });

  it("preserves literal channel markers in prose", () => {
    const text = "The Harmony spec uses `<|channel|>` and `<channel|>` markers.";
    expect(stripThink(text)).toBe(text);
  });

  it("preserves literal channel markers in code blocks", () => {
    const text = "Example:\n```\nif line.startswith('<channel|>'):\n    skip()\n```";
    expect(stripThink(text)).toBe(text);
  });
});

describe("extractThink", () => {
  it("returns no thinking for text without think tags", () => {
    expect(extractThink("Hello World")).toEqual([null, "Hello World"]);
  });

  it("extracts a single think block", () => {
    expect(extractThink("Hello <think>reasoning content\nhere</think> World")).toEqual([
      "reasoning content\nhere",
      "Hello  World",
    ]);
  });

  it("extracts a single thought block", () => {
    expect(extractThink("Hello <thought>reasoning content</thought> World")).toEqual([
      "reasoning content",
      "Hello  World",
    ]);
  });

  it("extracts multiple think blocks", () => {
    expect(extractThink("A<think>first</think>B<thought>second</thought>C")).toEqual([
      "first\n\nsecond",
      "ABC",
    ]);
  });

  it("extracts thinking when there is no visible content", () => {
    expect(extractThink("<think>just thinking</think>")).toEqual(["just thinking", ""]);
  });

  it("does not extract unclosed think blocks", () => {
    expect(extractThink("<think>unclosed thinking...")).toEqual([null, ""]);
  });

  it("extracts empty think blocks", () => {
    expect(extractThink("Hello <think></think> World")).toEqual(["", "Hello  World"]);
  });

  it("does not extract unclosed whitespace-only think blocks", () => {
    expect(extractThink("Hello <think>   \n World")).toEqual([null, "Hello <think>   \n World"]);
  });

  it("extracts mixed think and thought blocks", () => {
    expect(
      extractThink(
        "Start<think>first reasoning</think>middle<thought>second reasoning</thought>End",
      ),
    ).toEqual(["first reasoning\n\nsecond reasoning", "StartmiddleEnd"]);
  });

  it("extracts real-world Ollama inline reasoning", () => {
    const text = `<think>
The user is asking about TypeScript array mapping.
Let me explain the syntax and give examples.
</think>

Array mapping in TypeScript provides a concise way to create arrays. Here's the syntax:

\`\`\`typescript
items.filter(condition).map(expression)
\`\`\`

For example:
\`\`\`typescript
const squares = [...Array(10).keys()].map((x) => x ** 2);
\`\`\``;

    const [thinking, clean] = extractThink(text);

    expect(thinking?.toLowerCase()).toContain("array mapping");
    expect(thinking).toContain("Let me explain");
    expect(clean).toContain("Array mapping in TypeScript");
    expect(clean).not.toContain("<think>");
    expect(clean).not.toContain("</think>");
  });
});

describe("extractReasoning", () => {
  it("prefers reasoning content and strips inline think tags", () => {
    expect(extractReasoning("dedicated", null, "<think>inline</think>visible answer")).toEqual([
      "dedicated",
      "visible answer",
    ]);
  });

  it("falls back to thinking blocks", () => {
    expect(
      extractReasoning(
        null,
        [
          { type: "thinking", thinking: "step 1" },
          { type: "thinking", thinking: "step 2" },
          { type: "redacted_thinking" },
        ],
        "hello",
      ),
    ).toEqual(["step 1\n\nstep 2", "hello"]);
  });

  it("falls back to inline think tags", () => {
    expect(extractReasoning(null, null, "<think>plan</think>answer")).toEqual(["plan", "answer"]);
  });

  it("returns no reasoning for plain answers", () => {
    expect(extractReasoning(null, null, "plain answer")).toEqual([null, "plain answer"]);
  });

  it("falls through empty thinking blocks to inline think tags", () => {
    expect(extractReasoning(null, [], "<think>plan</think>answer")).toEqual(["plan", "answer"]);
  });
});
