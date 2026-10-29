import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateBrowserUseSiteRule, type BrowserAllowAllState,
  type BrowserUseCapability, type BrowserUseDecision } from '@memmy/local-api-contracts';
import { BrowserUseSitePolicyStore } from './browser-use-site-policy-store.js';

/** A separate website choice preserves both existing site rules and inherited app consent. */
export class BrowserAllowAll {
  readonly filePath: string;
  constructor(readonly agentDataDirectory: string, private readonly nativeAllowed: () => boolean) {
    this.filePath = path.join(agentDataDirectory, 'browser-use', 'allow-all-websites.json');
  }

  read(): BrowserAllowAllState {
    let enabled = false;
    try {
      const file = fs.lstatSync(this.filePath);
      if (file.isFile() && !file.isSymbolicLink() && file.size <= 4096) {
        const value: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          enabled = record.version === 1 && record.enabled === true;
        }
      }
    } catch { /* Old installations have no independent website choice. */ }
    const inherited = this.nativeAllowed();
    return { enabled, inherited, effective: enabled || inherited };
  }

  setEnabled(enabled: boolean): BrowserAllowAllState {
    if (typeof enabled !== 'boolean') throw new Error('Invalid browser approval');
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()
      || fs.lstatSync(this.filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Unsafe browser approval path');
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, enabled }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
    } finally { fs.rmSync(temporary, { force: true }); }
    return this.read();
  }

  decision(url: string, capability: BrowserUseCapability): BrowserUseDecision {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return 'block';
      // A global grant intentionally takes precedence over every remembered site restriction.
      if (this.read().effective) return 'allow';
      return this.siteRuleDecision(url, capability);
    } catch { return 'block'; }
  }

  /** The site's own rule. Grants that outlive the global switch, such as device permissions, must honor it. */
  siteRuleDecision(url: string, capability: BrowserUseCapability): BrowserUseDecision {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return 'block';
      return evaluateBrowserUseSiteRule(new BrowserUseSitePolicyStore(this.agentDataDirectory).list(), url, capability);
    } catch { return 'block'; }
  }
}
