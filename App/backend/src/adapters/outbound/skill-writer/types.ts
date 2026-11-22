/** Types module. */

/** Contract for skill manifest. */
export interface SkillManifest {
  targetId: string;
  content: string;
  marker: string;
}

/** Contract for memory plugin conflict. */
export interface MemoryPluginConflict {
  sourceId: string;
  displayName: string;
  configPath: string;
  installedPluginId: string;
}

/** Contract for skill target. */
export interface SkillTarget {
  readonly targetId: string;
  readonly displayName: string;
  resolveRootDirectory(): Promise<string | null>;
  install(manifest: SkillManifest): Promise<void>;
  uninstall(targetId: string): Promise<void>;
  isInstalled(targetId: string): Promise<boolean>;
  installPlugin?(targetId: string): Promise<void>;
  uninstallPlugin?(targetId: string): Promise<void>;
  isInstalledHookCurrent?(): Promise<boolean>;
  /**
   * 协作项目的全局指令块：写进这个 Agent 的全局指令文件，告诉它 memmy-project 技能在哪、什么时候先用它。
   * 与记忆块分开，生命周期跟着协作授权走。只有用户会读全局指令的文件型 Agent 实现它。
   */
  writeProjectSkillBootstrap?(): Promise<void>;
  /** 只删掉协作项目块，记忆块与用户自己写的内容都不动。 */
  removeProjectSkillBootstrap?(): Promise<void>;
  /** 全局指令文件里的协作项目块是否已经是这一版的内容；没有这一块时返回 false。 */
  isProjectSkillBootstrapCurrent?(): Promise<boolean>;
  /** 记忆钩子是否已经装在这台电脑上（不看版本），项目钩子的安装条件之一。 */
  isMemoryHookInstalled?(): Promise<boolean>;
  /**
   * 项目钩子：本机项目指令、协作项目段与项目知识库由它注入，与记忆钩子分开安装、分开算版本。
   * 只支持其中一部分宿主时可以不实现这几个方法。
   */
  installProjectHook?(): Promise<void>;
  uninstallProjectHook?(): Promise<void>;
  isProjectHookInstalled?(): Promise<boolean>;
  isProjectHookCurrent?(): Promise<boolean>;
  detectMemoryPluginConflict?(): Promise<MemoryPluginConflict | null>;
}
