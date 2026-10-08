import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseBrowserUsePattern, parseBrowserUseSitePolicyDocument,
  type BrowserUseSiteRule } from '@memmy/local-api-contracts';

export class BrowserUseSitePolicyStore {
  readonly filePath: string;
  constructor(agentDataDirectory: string) {
    this.filePath = path.join(agentDataDirectory, 'browser-use', 'site-policy.json');
  }

  list(): BrowserUseSiteRule[] {
    let raw: string;
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) throw new Error('Browser site policy exceeds size limit');
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rules = parseBrowserUseSitePolicyDocument(JSON.parse(raw) as unknown);
    if (!rules) throw new Error('Invalid browser site policy');
    return rules;
  }

  upsert(input: BrowserUseSiteRule): BrowserUseSiteRule[] {
    const canonical = parseBrowserUsePattern(input.pattern)?.canonical;
    if (!canonical) throw new Error('Invalid browser site pattern');
    const candidate: BrowserUseSiteRule = { pattern: canonical, access: input.access,
      downloads: input.downloads, uploads: input.uploads, fullCdp: input.fullCdp };
    if (!parseBrowserUseSitePolicyDocument({ version: 1, rules: [candidate] })) {
      throw new Error('Invalid browser site policy');
    }
    const existing = this.list();
    const rules = existing.filter(rule => parseBrowserUsePattern(rule.pattern)?.canonical !== canonical);
    rules.push(candidate);
    this.save(rules);
    return rules;
  }

  remove(pattern: string): BrowserUseSiteRule[] {
    const canonical = parseBrowserUsePattern(pattern)?.canonical;
    if (!canonical) throw new Error('Invalid browser site pattern');
    const rules = this.list().filter(rule => parseBrowserUsePattern(rule.pattern)?.canonical !== canonical);
    this.save(rules);
    return rules;
  }

  private save(rules: BrowserUseSiteRule[]): void {
    if (!parseBrowserUseSitePolicyDocument({ version: 1, rules })) throw new Error('Invalid browser site policy');
    const data = JSON.stringify({ version: 1, rules });
    if (Buffer.byteLength(data) > 128 * 1024) throw new Error('Browser site policy exceeds size limit');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
