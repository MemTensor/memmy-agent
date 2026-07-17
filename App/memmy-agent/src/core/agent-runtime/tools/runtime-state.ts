import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../../config/schema.js";

export interface RuntimeStateLike {
  model: string | null;
  maxIterations: number;
  currentIteration: number;
  toolNames: string[];
  workspace: string;
  providerRetryMode: string;
  maxToolResultChars: number;
  contextWindowTokens: number;
  webConfig: any;
  execConfig: any;
  subagents: any;
  runtimeVars: Record<string, any>;
  lastUsage: any;
  modelPreset: string | null;
  activePreset?: string | null;
  syncSubagentRuntimeLimits?: () => void;
}

export class RuntimeState implements RuntimeStateLike {
  values: Record<string, any>;
  private modelValue: string | null = null;
  private workspaceValue = "";
  private subagentsValue: any = null;
  private runtimeVarsValue: Record<string, any> = {};
  private lastUsageValue: any = {};
  private maxIterationsValue = 0;
  private currentIterationValue = 0;
  private toolNamesValue: string[] = [];
  private providerRetryModeValue = "standard";
  private maxToolResultCharsValue = 16_000;
  private contextWindowTokensValue = DEFAULT_CONTEXT_WINDOW_TOKENS;
  private webConfigValue: any = {};
  private execConfigValue: any = {};
  private modelPresetValue: string | null = null;
  private activePresetValue: string | null = null;

  constructor(init: Partial<RuntimeStateLike> & { values?: Record<string, any> } = {}) {
    Object.assign(this, init);
    const raw = init as Record<string, any>;
    this.maxIterations = raw.maxIterations ?? this.maxIterations;
    this.currentIteration = raw.currentIteration ?? this.currentIteration;
    this.toolNames = raw.toolNames ?? this.toolNames;
    this.providerRetryMode = raw.providerRetryMode ?? this.providerRetryMode;
    this.maxToolResultChars = raw.maxToolResultChars ?? this.maxToolResultChars;
    this.contextWindowTokens = raw.contextWindowTokens ?? this.contextWindowTokens;
    this.webConfig = raw.webConfig ?? this.webConfig;
    this.execConfig = raw.execConfig ?? this.execConfig;
    this.modelPreset = raw.modelPreset ?? this.modelPreset;
    this.activePreset = raw.activePreset ?? this.activePreset;
    this.values = init.values ?? init.runtimeVars ?? this.runtimeVars;
    this.runtimeVars = this.values;
  }

  get model(): string | null {
    return this.modelValue;
  }

  set model(value: string | null) {
    this.modelValue = value ?? null;
  }

  get workspace(): string {
    return this.workspaceValue;
  }

  set workspace(value: string) {
    this.workspaceValue = value ?? "";
  }

  get subagents(): any {
    return this.subagentsValue;
  }

  set subagents(value: any) {
    this.subagentsValue = value ?? null;
  }

  get runtimeVars(): Record<string, any> {
    return this.runtimeVarsValue;
  }

  set runtimeVars(value: Record<string, any>) {
    this.runtimeVarsValue = value ?? {};
    this.values = this.runtimeVarsValue;
  }

  get lastUsage(): any {
    return this.lastUsageValue;
  }

  set lastUsage(value: any) {
    this.lastUsageValue = value ?? {};
  }

  get maxIterations(): number {
    return this.maxIterationsValue;
  }

  set maxIterations(value: number) {
    this.maxIterationsValue = value;
  }

  get currentIteration(): number {
    return this.currentIterationValue;
  }

  set currentIteration(value: number) {
    this.currentIterationValue = value;
  }

  get toolNames(): string[] {
    return this.toolNamesValue;
  }

  set toolNames(value: string[]) {
    this.toolNamesValue = value ?? [];
  }

  get providerRetryMode(): string {
    return this.providerRetryModeValue;
  }

  set providerRetryMode(value: string) {
    this.providerRetryModeValue = value;
  }

  get maxToolResultChars(): number {
    return this.maxToolResultCharsValue;
  }

  set maxToolResultChars(value: number) {
    this.maxToolResultCharsValue = value;
  }

  get contextWindowTokens(): number {
    return this.contextWindowTokensValue;
  }

  set contextWindowTokens(value: number) {
    this.contextWindowTokensValue = value;
  }

  get webConfig(): any {
    return this.webConfigValue;
  }

  set webConfig(value: any) {
    this.webConfigValue = value;
  }

  get execConfig(): any {
    return this.execConfigValue;
  }

  set execConfig(value: any) {
    this.execConfigValue = value;
  }

  get modelPreset(): string | null {
    return this.modelPresetValue;
  }

  set modelPreset(value: string | null) {
    this.modelPresetValue = value ?? null;
  }

  get activePreset(): string | null {
    return this.activePresetValue;
  }

  set activePreset(value: string | null) {
    this.activePresetValue = value ?? null;
  }

  get(key: string, fallback: any = undefined): any {
    if (key in this) return (this as any)[key];
    return this.runtimeVars[key] ?? fallback;
  }

  set(key: string, value: any): void {
    if (key in this && key !== "values") (this as any)[key] = value;
    else this.runtimeVars[key] = value;
  }

  syncSubagentRuntimeLimits(): void {
    if (this.subagents && typeof this.subagents === "object") {
      this.subagents.maxIterations = this.maxIterations;
    }
  }

}
