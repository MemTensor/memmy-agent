/**
 * 引导结束后清掉引导期间在这个项目里产生的任务。
 *
 * 引导的体验段会让人点一次「继续」，那一下会在项目目录里新建一条任务，并按项目默认把这条任务共享到看板。
 * 引导一结束（完成、退出、跳过、云端判定结束），这条任务就该跟着消失：留着它就是演示项目里一条没人认领的任务。
 * 小饭团自己的脚本会话由云端在 `demo/end` 时删掉，不在这里。
 *
 * 清理分两步：先取消共享（云端副本随之删除，之后的同步也不会再把它传上去），再删掉本机会话本身。
 * 只在本机能跑收尾路径时才做：关掉 App 这类中断没有地方执行清理，也不做下次启动的补删。
 *
 * 这里只有纯判断与一次串行的清理，界面负责在引导收场时调用。
 */

/** 清理要用到的那几个字段：本机会话与它所属的项目。 */
export interface DemoCleanupTask {
  sessionKey: string;
  chatId: string;
  projectId: string | null;
  archived: boolean;
}

/**
 * 引导开始时这个项目里已有的任务。
 *
 * 结束时只删之后才出现的那些：项目哪怕是复用的，开始前就有的任务也不能算在引导头上。
 */
export function demoCleanupBaseline(tasks: readonly DemoCleanupTask[], localProjectId: string): Set<string> {
  return new Set(
    tasks
      .filter((task) => task.projectId === localProjectId && !task.archived)
      .map((task) => task.sessionKey)
  );
}

/** 引导结束后要删掉的任务：这个项目里、引导开始之后出现的、没有归档的那些。 */
export function demoTasksToRemove(
  tasks: readonly DemoCleanupTask[],
  localProjectId: string,
  baseline: ReadonlySet<string>
): DemoCleanupTask[] {
  return tasks.filter((task) => task.projectId === localProjectId
    && !task.archived
    && !baseline.has(task.sessionKey));
}

export interface RemoveDemoTasksInput {
  /** 当前本机任务清单；要删哪几条由 {@link demoTasksToRemove} 从它里面挑。 */
  tasks: readonly DemoCleanupTask[];
  /** 本机项目 id：任务按它归属。 */
  localProjectId: string;
  /** 云端项目 id：取消共享按它找项目。 */
  cloudProjectId: string;
  /** 引导开始时的快照。 */
  baseline: ReadonlySet<string>;
  /** 取消共享：云端副本一起删，并记下这次取消，之后的同步不会再传上去。 */
  unshare: (projectId: string, conversationId: string) => Promise<unknown>;
  /** 删掉本机会话本身。 */
  deleteSession: (sessionKey: string) => Promise<unknown>;
}

/**
 * 按快照删掉引导期间产生的任务，返回真正删掉的几条（调用方据此清任务列表、必要时换一条新会话）。
 *
 * 一步步来，一条失败不影响其余：取消共享失败时仍然删本机会话，看板上的那一行最多留到下一次轮询或手动删除，
 * 反过来说，本机会话留在原地才会让人以为清理根本没发生。
 */
export async function removeDemoTasks(input: RemoveDemoTasksInput): Promise<DemoCleanupTask[]> {
  const targets = demoTasksToRemove(input.tasks, input.localProjectId, input.baseline);
  const removed: DemoCleanupTask[] = [];
  for (const task of targets) {
    try {
      await input.unshare(input.cloudProjectId, task.sessionKey);
    } catch {
      // 云端删不掉时仍然删本机会话：看板那一行由后续轮询或本人手动删除收尾。
    }
    try {
      await input.deleteSession(task.sessionKey);
      removed.push(task);
    } catch {
      // 本机的会话删不掉时留着不动：下一次引导结束不会再碰它，至少不会假装删掉了。
    }
  }
  return removed;
}
