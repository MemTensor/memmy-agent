export {
  deepseekHarnessProjectKey,
  deepseekHarnessSessionDirectory,
  encodeDeepseekHarnessSegment,
  findLatestDeepseekHarnessSessionFile,
  parseDeepseekHarnessLogName,
  type DeepseekHarnessLogName,
  type DeepseekHarnessSessionFile
} from "@memmy/agent-source-core";

import { discoverDeepseekHarnessSessions as discover } from "@memmy/agent-source-core";

/** History scans include rotation backups; plugin live-session selection stays unchanged. */
export function discoverDeepseekHarnessSessions(options: Parameters<typeof discover>[0]) {
  return discover({ ...options, includeBackups: true });
}
