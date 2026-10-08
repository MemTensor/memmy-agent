import { z } from "zod";

export const ComputerHistoryPermissionsSchema = z.object({
  supported: z.boolean(),
  accessibility: z.boolean(),
  inputMonitoring: z.boolean(),
}).strict();
export type ComputerHistoryPermissions = z.infer<typeof ComputerHistoryPermissionsSchema>;
export type ComputerHistoryPermission = "accessibility" | "inputMonitoring";

const ObservationBehaviorSchema = z.enum(["observe", "do_not_observe"]);
export const ComputerHistoryObservationSettingsSchema = z.object({
  memory: z.object({ syncEnabled: z.boolean() }).strict().optional(),
  observation: z.object({
    defaultApplicationBehavior: ObservationBehaviorSchema,
    defaultURLBehavior: ObservationBehaviorSchema,
    rules: z.array(z.discriminatedUnion("scope", [
      z.object({ scope: z.literal("app"), bundleID: z.string().min(1), behavior: ObservationBehaviorSchema }).strict(),
      z.object({ scope: z.literal("url"), urlDomain: z.string().min(1), behavior: ObservationBehaviorSchema }).strict(),
    ])),
  }).strict(),
}).strict();
export type ComputerHistoryObservationSettings = z.infer<typeof ComputerHistoryObservationSettingsSchema>;

export const ComputerHistoryApplicationsSchema = z.object({
  applications: z.array(z.object({ bundleId: z.string(), name: z.string() }).strict()),
}).strict();

export const ComputerHistoryObservationStatusSchema = z.object({
  state: z.enum(["running", "paused", "stopped", "stopping", "failed"]),
}).strict();

// The Computer History snapshot contract.
//
// This lives on its own, free of any browser dependency, so the agent that
// produces the snapshot can assert against the very schema the desktop client
// validates with. Keeping it inside the client meant the only way to check the
// contract was to import the browser bundle, and the two sides drifted twice
// before anything noticed.

export const ComputerHistoryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  applications: z.array(z.string()),
  summaryWindow: z.enum(["10min", "6h"]).nullable(),
  // Keep segments visible when neither metadata nor legacy citations prove coverage.
  coveredHistoryIds: z.array(z.string()).default([]),
  skillMemoryIds: z.array(z.string()).optional(),
  // Linked Memory observation. Absent until optional sync succeeds.
  memoryId: z.string().optional(),
  pinned: z.boolean(),
  eventStreamPath: z.string().nullable(),
  sourceType: z.enum(["captured", "rollup", "imported", "demo_fixture"]),
  createdAt: z.string(),
  // Left out of what the desktop client receives: the timeline never renders a
  // summary's body, and it was most of every response. The agent reads bodies
  // in process.
  markdown: z.string().optional(),
  filePath: z.string(),
  replayPlan: z.object({
    sourcePath: z.string(),
    sourceHash: z.string(),
    status: z.enum(["ready", "not_replayable"]),
    steps: z.array(z.string()),
    variables: z.array(z.string())
  }).nullable().optional()
}).strict();

export const ComputerHistoryWorkflowSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  markdown: z.string(),
  filePath: z.string(),
  sourceHistoryId: z.string().nullable()
}).strict();

// Exported so the agent can assert its snapshot still satisfies the contract
// this client enforces. The schema is strict, so a field added on one side and
// not the other breaks the page rather than being ignored.
export const ComputerHistorySnapshotSchema = z.object({
  memorySync: z.object({
    lastSyncedAt: z.string().nullable(),
    error: z.string().nullable(),
    // Older agents omit the Skill status; new agents always return it.
    skillError: z.string().nullable().optional(),
    pendingDeletionCount: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  observation: z.object({
    state: z.enum(["running", "paused", "stopped", "stopping", "failed"]),
    startedAt: z.string().nullable(),
    segmentId: z.string().nullable(),
    segmentStartedAt: z.string().nullable(),
    error: z.string().nullable(),
    narrationError: z.string().nullable(),
    narrationErrorCategory: z.literal("quota_exhausted").nullable().optional(),
    modelSource: z.enum(["account", "byok"]).nullable().optional(),
    permissions: ComputerHistoryPermissionsSchema.optional(),
  }).strict(),
  histories: z.array(ComputerHistoryEntrySchema),
  workflows: z.array(ComputerHistoryWorkflowSchema),
  wechat: z.object({
    enabled: z.boolean(),
    connection: z.enum(["disabled", "unavailable", "needs_setup", "connecting", "connected", "error"]),
    phase: z.string().nullable(),
    error: z.string().nullable(),
  }).strict().optional(),
  privacy: z.object({
    screenshots: z.literal(false),
    audio: z.literal(false),
    rawRetentionHours: z.number(),
    markdownDirectory: z.string(),
    eventStreamDirectory: z.string(),

  }).strict()
}).strict();

// The app-icon route answers with one image rather than a snapshot, so it
// carries its own tiny schema next to the one it sits beside.
export const ApplicationIconSchema = z.object({
  icon: z.string().nullable()
}).strict();
