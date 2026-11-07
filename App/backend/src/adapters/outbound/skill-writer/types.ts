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
  /** Older CLI instructions also establish an existing integration for rollback. */
  isLegacySkillInstalled?(): Promise<boolean>;
  /** Detects any installed plugin version without requiring current contents. */
  isPluginInstalled?(): Promise<boolean>;
  installPlugin?(targetId: string): Promise<void>;
  /** Plugin removal already includes instructions and skill cleanup in one critical section. */
  readonly pluginUninstallIncludesSkills?: boolean;
  uninstallPlugin?(targetId: string): Promise<void>;
  isInstalledHookCurrent?(): Promise<boolean>;
  detectMemoryPluginConflict?(): Promise<MemoryPluginConflict | null>;
}
