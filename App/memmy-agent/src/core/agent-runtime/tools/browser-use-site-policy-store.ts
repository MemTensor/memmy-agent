import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_NATIVE_ALLOW_ALL_FILE_ENV, BROWSER_USE_DEFAULT_DECISION,
  evaluateBrowserUseSiteRule, parseBrowserUseSitePolicyDocument,
  browserUsePatternMatches,
  type BrowserUseCapability, type BrowserUseDecision } from '@memmy/local-api-contracts';
import { getDataDir } from '../../../config/paths.js';

function isAllowAllEnabled(filePath: string | undefined): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 4096) return false;
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.version === 1 && record.enabled === true;
  } catch { return false; }
}

/** Desktop shares site policy in Agent data and supplies its Computer Use approval path. */
export class BrowserUseSitePolicyReader {
  readonly allowAllFilePath: string;
  readonly nativeAllowAllFilePath: string | undefined;

  constructor(readonly filePath = path.join(getDataDir(), 'browser-use', 'site-policy.json'),
    options: { allowAllFilePath?: string; nativeAllowAllFilePath?: string } = {}) {
    this.allowAllFilePath = options.allowAllFilePath ?? path.join(path.dirname(filePath), 'allow-all-websites.json');
    this.nativeAllowAllFilePath = options.nativeAllowAllFilePath ?? process.env[BROWSER_NATIVE_ALLOW_ALL_FILE_ENV];
  }

  resolve(pageUrl: string, capability: BrowserUseCapability): { decision: BrowserUseDecision; matched: boolean } {
    try {
      if (!['http:', 'https:'].includes(new URL(pageUrl).protocol)) return { decision: 'block', matched: true };
    } catch { return { decision: 'block', matched: true }; }
    // These are broad user choices, not per-site grants. Never write them into
    // the fine-grained policy: turning them off must restore the original rules.
    if (isAllowAllEnabled(this.nativeAllowAllFilePath) || isAllowAllEnabled(this.allowAllFilePath)) {
      return { decision: 'allow', matched: true };
    }
    let raw: string;
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) return { decision: 'block', matched: true };
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { decision: BROWSER_USE_DEFAULT_DECISION, matched: false };
      }
      return { decision: 'block', matched: true };
    }
    try {
      const rules = parseBrowserUseSitePolicyDocument(JSON.parse(raw));
      return rules ? { decision: evaluateBrowserUseSiteRule(rules, pageUrl, capability),
        matched: rules.some(rule => browserUsePatternMatches(rule.pattern, pageUrl)) }
        : { decision: 'block', matched: true };
    } catch { return { decision: 'block', matched: true }; }
  }

  decision(pageUrl: string, capability: BrowserUseCapability): BrowserUseDecision {
    return this.resolve(pageUrl, capability).decision;
  }
}
