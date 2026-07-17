/** Definition for inline media placeholder. */

const INLINE_MEDIA_PLACEHOLDER = "[inline media omitted]";
const DATA_URL_MEDIA_PATTERN = /\bdata:(?:image|audio|video|application)\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/_=-]{120,}/giu;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]{0,200}\]\((?:data:[^)]+|blob:[^)]+|file:[^)]+|https?:\/\/[^)\s]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^)\s]*)?)[^)]*\)/giu;
const HTML_IMAGE_PATTERN = /<img\b[^>]*>/giu;
const BASE64_CANDIDATE_PATTERN = /[a-z0-9+/_-]{800,}={0,2}/giu;
const COMMON_MEDIA_BASE64_PREFIX_PATTERN = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Z)/u;

/** Handles strip inline media payloads. */
export function stripInlineMediaPayloads(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE_PATTERN, INLINE_MEDIA_PLACEHOLDER)
    .replace(HTML_IMAGE_PATTERN, INLINE_MEDIA_PLACEHOLDER)
    .replace(DATA_URL_MEDIA_PATTERN, INLINE_MEDIA_PLACEHOLDER)
    .replace(BASE64_CANDIDATE_PATTERN, (candidate) => looksLikeLargeBase64Media(candidate) ? INLINE_MEDIA_PLACEHOLDER : candidate)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeLargeBase64Media(candidate: string): boolean {
  if (COMMON_MEDIA_BASE64_PREFIX_PATTERN.test(candidate)) {
    return true;
  }
  if (!/[+/=_-]/u.test(candidate)) {
    return false;
  }
  return new Set(candidate.slice(0, 512)).size >= 24;
}
