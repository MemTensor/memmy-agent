/**
 * 引导结束后清掉引导期间在这个项目里产生的任务。
 *
 * 引导的体验段会让人点一次「继续任务」，那一下会在项目目录里新建一条任务，并按项目默认把这条任务共享到看板。
 * 引导一结束（完成、退出、跳过、云端判定结束），这条任务就该跟着消失：留着它就是演示项目里一条没人认领的任务。
 * 小饭团自己的脚本会话由云端在 `demo/end` 时删掉，不在这里。
 *
 * 要删哪几条只认磁盘上的会话文件（后端 `listProjectTasks` 按 `records.projectId` 扫出来的），
 * 不认界面的任务清单：清单要等一次刷新才有新任务，而引导结束的那一拍往往还没刷新，
 * 照清单判断会漏掉刚建出来的那一条。清单只当兜底，两份取并集。
 *
 * 清理分两步：先取消共享（云端副本随之删除，之后的同步也不会再把它传上去），再删掉本机会话本身。
 * 只在本机能跑收尾路径时才做：关掉 App 这类中断没有地方执行清理，也不做下次启动的补删。
 */

/** 本机会话的标识：`conversationId` 是会话文件的 id，`sessionKey` 是本机接口用的 key。 */
export interface DemoTaskRef {
  conversationId: string;
  sessionKey: string;
}

/** 本机会话的 sessionKey：本机后端把任务存成 `websocket_<conversationId>.jsonl`。 */
export function demoSessionKey(conversationId: string): string {
  return `websocket:${conversationId}`;
}

/**
 * 引导开始时项目里已有的会话。
 *
 * 演示项目是这次新建的，正常情况下这里是空集；留一份快照是为了「项目被复用」这类意外也删不到别人的任务。
 */
export function demoCleanupBaseline(conversations: readonly string[]): Set<string> {
  return new Set(conversations);
}

/**
 * 要删掉的会话：项目里现在有、引导开始时还没有的那些。
 *
 * `known` 是界面清单里的兜底来源（可能为空、也可能是旧的），与磁盘上的列表取并集：
 * 两边都认不出的会话不会被算进来，所以误删的门槛只有「快照里没有」这一条。
 */
export function demoTasksToRemove(
  conversations: readonly string[],
  baseline: ReadonlySet<string>,
  known: readonly string[] = []
): string[] {
  const targets = new Set<string>();
  for (const conversationId of [...conversations, ...known]) {
    if (!conversationId || baseline.has(conversationId)) continue;
    targets.add(conversationId);
  }
  return [...targets];
}

export interface RemoveDemoTasksInput {
  /** 要删的会话。 */
  conversationIds: readonly string[];
  /** 云端项目 id：取消共享按它找项目。 */
  cloudProjectId: string;
  /** 取消共享：云端副本一起删，并记下这次取消，之后的同步不会再传上去。 */
  unshare: (projectId: string, conversationId: string) => Promise<unknown>;
  /** 删掉本机会话本身。 */
  deleteSession: (sessionKey: string) => Promise<unknown>;
}

/**
 * 按给定会话删掉引导期间产生的任务，返回真正删掉的 conversationId（调用方据此清任务列表、必要时换一条新会话）。
 *
 * 一步步来，一条失败不影响其余：取消共享失败时仍然删本机会话，看板上的那一行最多留到下一次轮询或手动删除；
 * 反过来说，本机会话留在原地才会让人以为清理根本没发生。
 */
export async function removeDemoTasks(input: RemoveDemoTasksInput): Promise<string[]> {
  const removed: string[] = [];
  for (const conversationId of input.conversationIds) {
    try {
      await input.unshare(input.cloudProjectId, conversationId);
    } catch {
      // 云端删不掉时仍然删本机会话：看板那一行由后续轮询或本人手动删除收尾。
    }
    try {
      await input.deleteSession(demoSessionKey(conversationId));
      removed.push(conversationId);
    } catch {
      // 本机的会话删不掉时留着不动：至少不会假装删掉了。
    }
  }
  return removed;
}
