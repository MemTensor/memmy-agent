/**
 * 协作项目的「在其他 Agent 中使用」授权：查看状态、授权后安装组件、按 Agent 关闭、撤销。
 *
 * 授权覆盖本机检测到的全部 Agent，之后可以逐个关掉；读取其他 Agent 的任务记录与安装
 * `memmy-project` 都走这一份状态。用户通过「添加 Agent 支持」加进来的 Agent 也在同一个清单里，
 * 它们本来就算用户逐个主动添加过。
 */
import type { SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import {
  DEFAULT_COLLAB_AGENT_ACCESS,
  readCollabAgentAccess,
  writeCollabAgentAccess,
  type CollabAgentAccessState
} from "./collab-agent-access.js";
import type { SkillDistributionService } from "./skill-distribution-service.js";

/** 设置里列出的一个 Agent：能不能装、现在装没装、是不是被关掉了。 */
export interface CollabAgentAccessAgent {
  sourceId: string;
  name: string;
  /** 本机检测到这个 Agent（或用户添加过它），可以给它装组件。 */
  available: boolean;
  /** 是否启用；关掉的 Agent 不读取、也不安装。 */
  enabled: boolean;
  /** 技能目录里现在有 `memmy-project`。 */
  installed: boolean;
  /** 用户通过「添加 Agent 支持」加进来的，不是 Memmy 自己能读记录的内置 Agent。 */
  added: boolean;
}

export interface CollabAgentAccessView {
  granted: boolean;
  askedInProject: boolean;
  agents: CollabAgentAccessAgent[];
}

/** 授权或重新安装时一个 Agent 的结果，失败的那几个可以在界面上重试。 */
export interface CollabAgentInstallResult {
  sourceId: string;
  name: string;
  ok: boolean;
  /** 失败的原因，直接给界面看。 */
  message?: string;
}

export interface CollabAgentAccessService {
  /** 当前状态：上面三个字段，给接口与读取拦截用。 */
  read(): Promise<CollabAgentAccessState>;
  /** 设置页与授权弹窗要显示的清单。 */
  view(): Promise<CollabAgentAccessView>;
  /** 授权并安装（`granted: true`），或撤销并移除组件（`granted: false`）。 */
  setGranted(granted: boolean): Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  /** 设置里逐个关闭或打开某个 Agent；打开时若已整体授权，顺手把组件装回去。 */
  setAgentEnabled(sourceId: string, enabled: boolean): Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  /** 已授权但没装上（例如当时 Agent 不在、装失败）：重新装一次，可只装指定几个。 */
  install(sourceIds?: readonly string[]): Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  /** 记下已经在协作项目里询问过一次，之后不再主动询问。 */
  markAsked(): Promise<CollabAgentAccessState>;
  /**
   * 可以读取哪些 Agent 的任务：未授权时为空，已授权时是全部启用且可用的 Agent。
   * 本机任务读取器用它把扫描范围缩到这些 Agent，关掉的 Agent 不会被读一次再过滤。
   */
  readableSourceIds(): Promise<string[]>;
}

export interface CreateCollabAgentAccessServiceOptions {
  homeDirectory?: string;
  skillDistributionService: SkillDistributionService;
  sourceRegistry: SourceRegistry;
}

export function createCollabAgentAccessService(
  options: CreateCollabAgentAccessServiceOptions
): CollabAgentAccessService {
  const home = (): string | undefined => options.homeDirectory;

  async function readState(): Promise<CollabAgentAccessState> {
    return await readCollabAgentAccess(home());
  }

  /** 内置 Agent 里本机真的有的那些：`detect()` 为 true，或它们的技能目录里已经装着组件。 */
  async function builtinAgents(): Promise<Array<{ sourceId: string; name: string; available: boolean; installed: boolean }>> {
    const entries: Array<{ sourceId: string; name: string; available: boolean; installed: boolean }> = [];
    for (const adapter of options.sourceRegistry.list()) {
      const sourceId = adapter.descriptor.sourceId;
      const installed = await options.skillDistributionService.hasProjectSkill(sourceId).catch(() => false);
      const detected = await adapter.detect().catch(() => false);
      if (!detected && !installed) continue;
      entries.push({ sourceId, name: adapter.descriptor.displayName, available: true, installed });
    }
    return entries;
  }

  async function view(): Promise<CollabAgentAccessView> {
    const state = await readState();
    const agents: CollabAgentAccessAgent[] = [];
    for (const agent of await builtinAgents()) {
      agents.push({
        sourceId: agent.sourceId,
        name: agent.name,
        available: agent.available,
        enabled: !state.disabledAgents.includes(agent.sourceId),
        installed: agent.installed,
        added: false
      });
    }
    return { granted: state.granted, askedInProject: state.askedInProject, agents };
  }

  /**
   * 一个 Agent 的安装入口。授权只覆盖 Memmy 内置支持的来源，用户自己添加的 Agent
   * 不在这份清单里，也就不用这里装。
   */
  async function installOne(agent: CollabAgentAccessAgent): Promise<CollabAgentInstallResult> {
    await options.skillDistributionService.installProjectSkill(agent.sourceId);
    return { sourceId: agent.sourceId, name: agent.name, ok: true };
  }

  async function removeOne(agent: CollabAgentAccessAgent): Promise<void> {
    await options.skillDistributionService.removeProjectSkill(agent.sourceId).catch(() => undefined);
  }

  /** 装全部启用且可用的 Agent；`only` 限定时只装这几个。装失败的不抛出，逐个记下原因。 */
  async function installAll(only?: readonly string[]): Promise<CollabAgentInstallResult[]> {
    const wanted = only ? new Set(only) : null;
    const { agents } = await view();
    const results: CollabAgentInstallResult[] = [];
    for (const agent of agents) {
      if (!agent.enabled || !agent.available) continue;
      if (wanted && !wanted.has(agent.sourceId)) continue;
      try {
        results.push(await installOne(agent));
      } catch (error) {
        results.push({
          sourceId: agent.sourceId,
          name: agent.name,
          ok: false,
          message: error instanceof Error ? error.message : "安装失败"
        });
      }
    }
    return results;
  }

  return {
    read: readState,

    view,

    async setGranted(granted) {
      const state = await readState();
      // 撤销只从设置里发起，本身就是「主动移除」：记下已询问，之后不再主动弹窗。
      await writeCollabAgentAccess({ ...state, granted, askedInProject: state.askedInProject || !granted }, home());
      if (!granted) {
        // 撤销：停止读取并移除组件；已关联的任务保留在项目里，只是不再同步。
        // 只撤内置 Agent 的组件：用户通过「添加 Agent 支持」加进来的那些，
        // 添加它们本身就是那一下授权，不随这一项授权一起移除。
        await options.skillDistributionService.removeProjectSkills().catch(() => []);
        return { view: await view(), results: [] };
      }
      // 先装完再读状态：view 里的「已安装」是查磁盘得来的，反了就会一直显示未安装。
      const results = await installAll();
      return { view: await view(), results };
    },

    async setAgentEnabled(sourceId, enabled) {
      const state = await readState();
      const disabled = state.disabledAgents.filter((id) => id !== sourceId);
      const next = enabled ? disabled : [...disabled, sourceId];
      await writeCollabAgentAccess({ ...state, disabledAgents: next }, home());
      const agent = (await view()).agents.find((item) => item.sourceId === sourceId);
      if (!agent) return { view: await view(), results: [] };
      if (!enabled) {
        await removeOne(agent);
        return { view: await view(), results: [] };
      }
      if (!state.granted) return { view: await view(), results: [] };
      try {
        const installed = await installOne(agent);
        return { view: await view(), results: [installed] };
      } catch (error) {
        return {
          view: await view(),
          results: [{
            sourceId,
            name: agent.name,
            ok: false,
            message: error instanceof Error ? error.message : "安装失败"
          }]
        };
      }
    },

    async install(sourceIds) {
      // 没授权就不写入：重新安装只是补装漏掉的，不是绕过授权装一遍。
      const state = await readState();
      if (!state.granted) return { view: await view(), results: [] };
      const results = await installAll(sourceIds);
      return { view: await view(), results };
    },

    async markAsked() {
      const state = await readState();
      return await writeCollabAgentAccess({ ...state, askedInProject: true }, home());
    },

    async readableSourceIds() {
      const state = await readState();
      if (!state.granted) return [];
      const ids = options.sourceRegistry.list()
        .map((adapter) => adapter.descriptor.sourceId)
        .filter((sourceId) => !state.disabledAgents.includes(sourceId));
      return ids;
    }
  };
}

/** 全新安装时的初始状态，给测试与第一次读接口用。 */
export function emptyCollabAgentAccessState(): CollabAgentAccessState {
  return { ...DEFAULT_COLLAB_AGENT_ACCESS, disabledAgents: [] };
}
