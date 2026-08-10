import type { RuntimeNamespace } from "../../types.js";
import type { Repositories } from "../../storage/repositories.js";

export type ProjectGoalStatus = "candidate" | "active" | "completed" | "archived";
export type ProjectWorkItemStatus = "pending" | "active" | "blocked" | "completed" | "archived";
export type ProjectFactKind = "decision" | "constraint";
export type ProjectFactStatus = "candidate" | "active" | "superseded" | "archived";

export interface ProjectGoalRecord {
  id: string;
  namespaceId: string;
  userId: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  title: string;
  summary: string;
  detail: string;
  acceptanceCriteria: string[];
  constraints: string[];
  status: ProjectGoalStatus;
  version: number;
  supersedesId?: string;
  sourceMemoryIds: string[];
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkItemRecord {
  id: string;
  namespaceId: string;
  userId: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  goalId?: string;
  title: string;
  summary: string;
  nextStep: string;
  acceptanceCriteria: string[];
  constraints: string[];
  status: ProjectWorkItemStatus;
  focused: boolean;
  sourceMemoryIds: string[];
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFactRecord {
  id: string;
  namespaceId: string;
  userId: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  kind: ProjectFactKind;
  content: string;
  status: ProjectFactStatus;
  supersedesId?: string;
  sourceMemoryIds: string[];
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectContextRequest {
  namespace: RuntimeNamespace;
}

export interface ProjectContextProposeGoalRequest extends ProjectContextRequest {
  title: string;
  summary: string;
  detail: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  sourceMemoryIds?: string[];
  provenance?: Record<string, unknown>;
}

export interface ProjectContextReadState {
  namespaceId: string;
  activeGoal?: ProjectGoalRecord;
  goals: ProjectGoalRecord[];
  workItems: ProjectWorkItemRecord[];
  focusedWorkItem?: ProjectWorkItemRecord;
  facts: ProjectFactRecord[];
}

export interface ProjectContextStableResult {
  namespaceId: string;
  status: "ready" | "no_confirmed_goal" | "conflict";
  version: number;
  goal: ProjectGoalRecord | null;
  focusedWorkItem: ProjectWorkItemRecord | null;
  facts: ProjectFactRecord[];
  markdown: string;
  sourceMemoryIds: string[];
  generatedAt: string;
}

export interface ProjectContextServiceOptions {
  repositories: Repositories;
  now?: () => string;
  id?: (prefix: string) => string;
}
