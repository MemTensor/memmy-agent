/** Type definition for redaction rule. */
type RedactionRule = {
  /** Pattern. */
  pattern: RegExp;
  /** Token. */
  token: string;
  /** Replace. */
  replace?: (match: string, ...groups: string[]) => string;
};

const REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    token: "[REDACTED:ssh_private_key]"
  },
  {
    pattern: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    token: "[REDACTED:authorization_bearer]",
    replace: (_match, prefix: string) => `${prefix}[REDACTED:authorization_bearer]`
  },
  {
    pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{40,}\b/g,
    token: "[REDACTED:anthropic_api_key]"
  },
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g,
    token: "[REDACTED:openai_api_key]"
  },
  {
    pattern: /\bAIza[A-Za-z0-9_-]{32,}\b/g,
    token: "[REDACTED:google_api_key]"
  },
  {
    pattern: /\b([A-Za-z0-9_]*password[A-Za-z0-9_]*\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s#&]+)/gi,
    token: "[REDACTED:password]",
    replace: (_match, prefix: string) => `${prefix}[REDACTED:password]`
  }
];

const BASE64_SECRET_TOKEN = "[REDACTED:base64_secret]";
const BASE64_SECRET_MIN_LENGTH = 32;
const LARGE_BASE64_PAYLOAD_MIN_LENGTH = 4096;

/**
 * Redacts common secrets from text.
 *
 * @param input Raw message text from an external Agent.
 * @returns The plain text with secrets replaced, or the original text when no rule matches.
 */
export function redactSecrets(input: string): string {
  const withoutLargeBinaryPayloads = redactBase64Runs(input, LARGE_BASE64_PAYLOAD_MIN_LENGTH);
  const redacted = REDACTION_RULES.reduce((current, rule) => {
    if (rule.replace) {
      return current.replace(rule.pattern, rule.replace);
    }

    return current.replace(rule.pattern, rule.token);
  }, withoutLargeBinaryPayloads);

  return redactBase64Runs(redacted, BASE64_SECRET_MIN_LENGTH);
}

function redactBase64Runs(input: string, minLength: number): string {
  let output = "";
  let cursor = 0;
  let index = 0;

  while (index < input.length) {
    if (!isBase64CoreChar(input.charCodeAt(index))) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < input.length && isBase64CoreChar(input.charCodeAt(index))) {
      index += 1;
    }
    const coreEnd = index;
    let padding = 0;
    while (padding < 2 && input.charCodeAt(index) === 61) {
      index += 1;
      padding += 1;
    }

    if (coreEnd - start >= minLength && hasBase64Boundary(input, start, index)) {
      output += input.slice(cursor, start);
      output += BASE64_SECRET_TOKEN;
      cursor = index;
    }
  }

  if (cursor === 0) {
    return input;
  }

  return output + input.slice(cursor);
}

function hasBase64Boundary(input: string, start: number, end: number): boolean {
  return !isAsciiWord(input.charCodeAt(start - 1)) && !isAsciiWord(input.charCodeAt(end));
}

function isBase64CoreChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

function isAsciiWord(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}
