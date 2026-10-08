import fs from 'node:fs';
import path from 'node:path';
import { evaluateBrowserUseSiteRule, parseBrowserUseSitePolicyDocument,
  browserUsePatternMatches,
  type BrowserUseCapability, type BrowserUseDecision } from '@memmy/local-api-contracts';
import { getDataDir } from '../../../config/paths.js';

/** Policy is shared with Desktop through Agent's own data directory only. */
export class BrowserUseSitePolicyReader {
  constructor(readonly filePath = path.join(getDataDir(), 'browser-use', 'site-policy.json')) {}

  resolve(pageUrl: string, capability: BrowserUseCapability): { decision: BrowserUseDecision; matched: boolean } {
    let raw: string;
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) return { decision: 'block', matched: true };
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { decision: capability === 'fullCdp' ? 'block' : 'ask', matched: false };
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
