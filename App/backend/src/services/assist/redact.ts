/**
 * 回传前隐藏密钥。
 *
 * <p>执行方的 Agent 会把命令与输出原样带进执行过程，里面有可能是她自己的密钥、令牌与密码。
 * 上传进度与结果之前统一过一遍这里：命中的片段换成「[已隐藏]」，并统计替换了几处，
 * 双方在协助会话里能看到「回传前隐藏了 N 处疑似密钥」。</p>
 *
 * <p>规则只认形状确定的凭据，宁可漏掉也不误伤普通文本：例如「sk-」后面不足 20 个字符不算，
 * 「password」只有出现在赋值或键值里才算。隐藏过的文字不再包含原文，重复处理也不会重复计数。</p>
 */

/** 替换上去的文字：双方在协助会话里看到它就知道这里被隐藏了。 */
export const REDACTED = "[已隐藏]";

export interface RedactionResult {
  text: string;
  /** 替换了几处。 */
  count: number;
}

/** 一条规则：命中的整段换成 {@link REDACTED}，或者只替换命中的那一部分。 */
interface RedactionRule {
  pattern: RegExp;
  /** 保留匹配到的第一段（例如 `Authorization: Bearer ` 这个前缀），只替换其余部分。 */
  keep?: number;
  /** 命中的是哪一类凭据：只用于「哪里疑似有密钥」的提示，不参与替换。 */
  kind: string;
}

/**
 * 规则按「越长越具体的先替换」排列：PEM 块先整段吃掉，其余按前缀识别。
 * 键值型规则放在最后，避免把已经替换成 `[已隐藏]` 的值再算一次。
 */
const RULES: readonly RedactionRule[] = [
  // PEM 私钥：从 BEGIN 到 END 整段，不管中间有多少行。
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, kind: "私钥" },
  // AWS 访问密钥（AKIA/ASIA 开头，共 20 位）。
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, kind: "AWS 访问密钥" },
  // GitHub 的各种令牌：ghp_/gho_/ghu_/ghs_/ghr_ 与细粒度令牌 github_pat_。
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, kind: "GitHub 令牌" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, kind: "GitHub 令牌" },
  // OpenAI / Anthropic 的密钥：sk-、sk-ant-、sk-proj-。后面不足 20 个字符不算，免得误伤「sk-learn」这类词。
  { pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/gu, kind: "API Key" },
  // Slack 的 xox 系列。
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu, kind: "Slack 令牌" },
  // GitLab 个人访问令牌。
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu, kind: "GitLab 令牌" },
  // Google API Key：AIza 加 35 位。
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu, kind: "Google API Key" },
  // JWT：三段 base64url，第一段以 eyJ（`{"`）开头。
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/gu, kind: "JWT" },
  // 请求头里的凭据：保留头名与认证方式，只隐藏值。
  { pattern: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token|Digest)?\s*)([^\s"',;]+)/giu, keep: 1, kind: "Authorization 头" },
  { pattern: /\b(Cookie\s*:\s*)([^\n\r]+)/giu, keep: 1, kind: "Cookie 头" },
  { pattern: /\b(Set-Cookie\s*:\s*)([^\n\r]+)/giu, keep: 1, kind: "Cookie 头" },
  // 赋值与键值：PASSWORD=…、*_TOKEN=…、*_SECRET=…、*_API_KEY=…、password: …，键名大小写不敏感。
  {
    pattern: /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET))(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/giu,
    keep: 2,
    kind: "密码或令牌赋值"
  }
];

/** 已经替换过的标记不再参与后续规则：它本身不含凭据，但会挡住「值」的匹配。 */
function alreadyRedacted(value: string): boolean {
  return value === REDACTED || value.startsWith(REDACTED);
}

/** 检测到的一处疑似凭据：位置、长度、哪一类。只用来提示「哪里要去掉」，不带原文。 */
export interface SecretHit {
  /** 在传入的那段文字里的起始位置。 */
  index: number;
  length: number;
  /** 哪一类，例如「私钥」「GitHub 令牌」。 */
  kind: string;
}

/**
 * 只检测、不替换：返回命中的位置与类别。请求发出前用它挡住夹带密钥的请求。
 * 规则与 {@link redactSecrets} 完全同一套；重叠的命中只留最靠前的那个，同一处不会报两遍。
 */
export function findSecrets(input: string): SecretHit[] {
  if (!input) return [];
  const hits: SecretHit[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of input.matchAll(rule.pattern)) {
      if (typeof match.index !== "number" || !match[0]) continue;
      hits.push({ index: match.index, length: match[0].length, kind: rule.kind });
    }
  }
  hits.sort((left, right) => left.index - right.index || right.length - left.length);
  const merged: SecretHit[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.index < last.index + last.length) continue;
    merged.push(hit);
  }
  return merged;
}

/**
 * 隐藏一段文字里的凭据。返回替换后的文字与替换处数。
 * `count` 只统计真正含原文的替换：命中的值已经是 {@link REDACTED} 时不再计数。
 */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      const keep = rule.keep ?? 0;
      const kept = keep > 0 ? groups.slice(0, keep).map((value) => String(value ?? "")).join("") : "";
      const rest = keep > 0 ? match.slice(kept.length) : match;
      if (alreadyRedacted(rest.trim())) return match;
      count += 1;
      return keep > 0 ? `${kept}${REDACTED}` : REDACTED;
    });
  }
  return { text, count };
}

/** 执行过程里的一项：只处理会带出原文的字段（说明、思考、命令与输出），名称与状态原样保留。 */
export interface RedactableTranscriptItem {
  kind: string;
  [key: string]: unknown;
}

export interface RedactTranscriptResult<T> {
  items: T[];
  count: number;
}

/**
 * 隐藏一份执行过程里的凭据。工具调用的名称（`rm -rf ~/x`、`读取 ~/.ssh/id_rsa`）与状态不动：
 * 它们是「做到了哪一步」的一部分，界面要按原样显示；命令里带令牌的情况由 input 那一份覆盖。
 */
export function redactTranscript<T extends RedactableTranscriptItem>(items: readonly T[]): RedactTranscriptResult<T> {
  let count = 0;
  const redacted = items.map((item) => {
    if (item.kind === "text" || item.kind === "thinking" || item.kind === "user") {
      const text = typeof item.text === "string" ? item.text : "";
      const result = redactSecrets(text);
      count += result.count;
      return result.count ? { ...item, text: result.text } : item;
    }
    if (item.kind === "tool") {
      const input = typeof item.input === "string" ? item.input : "";
      const output = typeof item.output === "string" ? item.output : "";
      const redactedInput = redactSecrets(input);
      const redactedOutput = redactSecrets(output);
      count += redactedInput.count + redactedOutput.count;
      if (!redactedInput.count && !redactedOutput.count) return item;
      return {
        ...item,
        ...(redactedInput.count ? { input: redactedInput.text } : {}),
        ...(redactedOutput.count ? { output: redactedOutput.text } : {})
      };
    }
    return item;
  });
  return { items: redacted, count };
}

/** 一串步骤（摘要）：做了什么、产出，两段都过一遍。 */
export function redactSteps(steps: ReadonlyArray<{ text: string; output?: string }>): {
  steps: Array<{ text: string; output?: string }>;
  count: number;
} {
  let count = 0;
  const result = steps.map((step) => {
    const text = redactSecrets(step.text);
    const output = step.output === undefined ? null : redactSecrets(step.output);
    count += text.count + (output?.count ?? 0);
    if (!text.count && !output?.count) return step;
    return { text: text.text, ...(output?.count ? { output: output.text } : step.output === undefined ? {} : { output: step.output }) };
  });
  return { steps: result, count };
}
