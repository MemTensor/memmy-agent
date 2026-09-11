import { z } from "zod";

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
  pinned: z.boolean(),
  eventStreamPath: z.string().nullable(),
  sourceType: z.enum(["captured", "rollup", "imported", "demo_fixture"]),
  createdAt: z.string(),
  markdown: z.string(),
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
  observation: z.object({
    state: z.enum(["running", "paused", "stopped", "stopping", "failed"]),
    startedAt: z.string().nullable(),
    segmentId: z.string().nullable(),
    segmentStartedAt: z.string().nullable(),
    error: z.string().nullable(),
    narrationError: z.string().nullable()
  }).strict(),
  cuaRun: z.object({
    kind: z.enum(["smoke", "workflow"]).nullable(),
    status: z.enum(["idle", "running", "completed", "failed"]),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    output: z.string(),
    error: z.string().nullable()
  }).strict(),
  histories: z.array(ComputerHistoryEntrySchema),
  workflows: z.array(ComputerHistoryWorkflowSchema),
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
