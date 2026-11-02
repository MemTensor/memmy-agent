/** Preview input snapshots, copied from the existing request builders.
 * Instructions come from source; conversation values below are synthetic examples.
 * No model is called to generate titles or export content.
 */
// Memory/src/service/evolution/span-pipeline.ts: CAPTURE_SUMMARY_SYSTEM_PROMPT
const SUMMARY_PROMPT = "You extract a short title and the most useful durable fact from a single user/agent exchange for future retrieval.\n\nRules:\n- Output MUST be a single JSON object: { \"title\": \"...\", \"summary\": \"...\" }\n- \"title\": a short name of at most 30 characters. Describe what the exchange is about. Never copy or truncate the opening user message. Omit meta narration such as \"user asks\".\n- \"summary\": at most 180 characters of retrievable durable facts.\n- Preserve concrete retrieval anchors: names, aliases, dates, times, places,\n  relationships, numbers, exact titles, object names, event names, preferences,\n  decisions, commitments, outcomes, confirmed answers, file paths, commands,\n  and error signatures.\n- Treat the conversation as evidence, not the memory itself. Do NOT write vague\n  summaries like \"A and B discussed X\" unless the discussion itself is the\n  durable fact.\n- Prefer atomic real-world facts: who did/wanted/said/decided what, when/where,\n  and with what outcome.\n- If multiple independent facts appear, cover every independently retrievable\n  fact and list them compactly with semicolons instead of dropping one or\n  merging them into a broad umbrella topic.\n- Preserve temporal expressions as stated in the source. Keep relative wording\n  such as \"last Friday\", \"tomorrow\", or \"next month\" as relative wording in the\n  summary. Do NOT resolve, normalize, infer, or replace a relative expression\n  with an absolute date/time, even when a session timestamp is available. If the\n  source itself provides an absolute date/time, preserve it without alteration.\n- Use future-query words from the source. Prefer concrete event/action/object\n  terms over generic words such as \"support\", \"journey\", \"strength\", or\n  \"discussion\" unless those are the only durable fact.\n- For images, files, or search results, preserve image captions, visible text,\n  retrieval queries, topics, and answer-relevant evidence; omit raw URLs unless\n  the URL itself is important.\n- ATTACHMENT METADATA is internal context. Never use an attachment wrapper,\n  generic \"attachment/file\" wording, or metadata alone as the summary.\n- Preserve original speaker/person names. User/assistant roles may be import\n  roles and must not replace real participants when names are present.\n- Do not invent facts. Do not infer ownership from neighboring turns.\n- Do NOT prefix with \"The user said\" / \"用户说了\". Just state the fact.\n- If no durable fact is present, summarize the concrete request/result that\n  would be most useful for retrieval.";

// Memory/src/service/retrieval/retrieval-service.ts: QUERY_REWRITE_SYSTEM_PROMPT
const SEARCH_PROMPT = "You rewrite a user's memory search request into exactly 3 complementary retrieval queries.\n\nGoal:\n- Maximize recall from a personal memory store while staying faithful to the user's request.\n- Preserve concrete entities, people, dates, places, relationship words, numbers, and domain keywords.\n- Keep useful aliases or likely paraphrases when they help retrieval.\n- Retrieve distinct evidence needed for multi-fact, temporal, comparison, counting, and inference questions.\n\nRules:\n1. Produce 3 short standalone retrieval queries.\n2. Do not answer the question.\n3. Do not add facts that are not grounded in the original request.\n4. Keep the original language when it carries names or exact wording; use bilingual paraphrases only when the request itself mixes languages.\n5. Query 1 must preserve the original request and its concrete anchors.\n6. Query 2 must target the main entity, event, relationship, or time expression with useful aliases.\n7. Query 3 must target one complementary evidence facet needed to resolve the request. For indirect questions, retrieve stated preferences, plans, goals, prior events, or constraints instead of guessing the conclusion. For references such as \"that book\" or \"it\", target the earlier source fact alone and intentionally omit downstream entities that may not occur in the source memory.\n8. Keep each query to one evidence facet and roughly 2-12 content words. Do not join stages with \"and\", \"follow-up\", parentheses, or lists of synonyms.\n9. Do not produce three near-duplicate paraphrases.\n\nReturn JSON only:\n{\n  \"queries\": [\"query 1\", \"query 2\", \"query 3\"]\n}";

// Memory/src/service/evolution/l3-world-model-pipeline.ts: GENERAL_RULES_PROMPT
const EVOLUTION_PROMPT = "You maintain \"General Rules and Safety Constraints\".\nThe input contains the complete current field and a chronological batch of new RawTurns.\n\nKeep only:\n1. operational rules explicitly stated by the user that remain reusable across no-project tasks;\n2. general safety guardrails supported by actual tool errors, risky outcomes, or user corrections.\n\nRemove or ignore:\n- project-, file-, repository-, customer-, or one-off-task-specific information;\n- steps or recommendations for solving a particular task;\n- unsupported Agent preferences or guesses;\n- old rules explicitly superseded by newer user requirements.\n\nMerge equivalent items and remove superseded items. Sort explicit user rules and high-risk guardrails before weaker or lower-frequency items.\n\nChoose exactly one operation:\n- \"create\": the current field is empty and the evidence produces non-empty content;\n- \"update\": the current field is non-empty and the complete final content differs from it; use an empty final content only when newer evidence explicitly removes or supersedes every existing item;\n- \"noop\": the final content would not change.\n\nFor \"noop\", return an empty content field and do not repeat the current field. For \"create\" and \"update\", return the complete merged final content, not a delta. An empty content field with \"update\" means clear the existing field; an empty content field with \"noop\" means leave it unchanged.\nWrite the content in the language of the current field. If the current field is empty, follow the interface language when one is pinned; otherwise use the dominant language of the user requests in the RawTurns. Do not translate the content merely because this instruction is written in English.\nReturn exactly one valid JSON object with the required keys. Do not include Markdown or explanatory text.\n\nReturn exactly one of:\n{\"op\":\"noop\",\"general_rules_and_safety_constraints\":\"\"}\n{\"op\":\"create\",\"general_rules_and_safety_constraints\":\"complete final content\"}\n{\"op\":\"update\",\"general_rules_and_safety_constraints\":\"complete final content\"}";

const language = "All natural-language answers MUST be in Simplified Chinese (zh-CN).";
const exchanges = [
  { user: "以后修改产品文档前先给我看修改建议，确认以后再保存。", assistant: "好的，先给出建议，确认后再保存。" },
  { user: "导出的请求内容保留原文，不要再总结或者额外起标题。", assistant: "导出保留请求输入原文，不额外生成标题。" }
];
const serialize = (value: unknown) => JSON.stringify(value, null, 2);
const messages = (system: string, user: string) => ({ messages: [{ role: "system", content: system }, { role: "user", content: user }] });

export function memoryMockInput(operation: "summary" | "embedding" | "evolution" | "search", index: number, at: string): string {
  const turn = exchanges[index % exchanges.length]!;
  switch (operation) {
    // embedder.ts requestOpenAiShape: inputs are a batch, not a generated batch name.
    case "embedding": return serialize({ input: [turn.user, turn.assistant] });
    // span-pipeline.ts summarizeTraceForCapture + traceSummaryPayload.
    case "summary": return serialize({ messages: [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "system", content: language },
      { role: "user", content: `CAPTURED AT: ${at}\n\nUSER:\n${turn.user}\n\nASSISTANT:\n${turn.assistant}` }
    ] });
    // retrieval-service.ts planQueryRewrite, operation retrieval.query_rewrite.v1.
    case "search": return serialize(messages(SEARCH_PROMPT, "USER MEMORY SEARCH REQUEST:\n之前对修改文档和导出内容有什么要求？"));
    // l3-world-model-pipeline.ts dynamicInputForField + rawTurnEvidence;
    // strict-json-completion.ts sends this JSON as the user message.
    case "evolution": return serialize(messages(`${EVOLUTION_PROMPT}\n\n${language}`, JSON.stringify({
      current_field: "", raw_turns: [{ raw_turn_id: `sample-raw-turn-${index}`, status: "completed", user_text: turn.user,
        assistant_text: turn.assistant, tool_calls: [], tool_results: [], feedback: [] }]
    })));
  }
}

export function agentMockInput(prompt: string, title = false): string {
  // webui-title.ts requestModelTitle. Ordinary agent examples contain user input.
  if (!title) return serialize({ messages: [{ role: "user", content: prompt }] });
  return serialize(messages("You write short, neutral chat titles. Return only the title text.", [
    "Generate a concise title for this chat.", "Rules:", "- Use the same language as the user when practical.",
    "- 3 to 8 words.", "- No quotes.", "- No punctuation at the end.", "- Return only the title.", "", `User: ${prompt.slice(0,1000)}`
  ].join("\n")));
}
