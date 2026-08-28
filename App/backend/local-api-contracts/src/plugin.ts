/** Memmy Plugin Protocol contracts. */
import { z } from "zod";

export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

const PluginIdentifierSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const PluginRuntimeSchema = z.object({
  adapter: z.enum(["mcp", "http", "command"]),
  config: z.record(z.string(), z.unknown()).optional()
});
export type PluginRuntime = z.infer<typeof PluginRuntimeSchema>;

export const PluginCapabilitySchema = z.object({
  id: PluginIdentifierSchema,
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2_000),
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
  execution: z.enum(["request", "job"]),
  examples: z.array(z.string().trim().min(1).max(500)).max(20).optional()
});
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginPermissionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("network"),
    hosts: z.array(z.string().trim().min(1)).min(1),
    description: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal("filesystem"),
    paths: z.array(z.string().trim().min(1)).min(1),
    access: z.enum(["read", "write", "read-write"]),
    description: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal("secret"),
    keys: z.array(PluginIdentifierSchema).min(1),
    description: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal("host-service"),
    services: z.array(PluginIdentifierSchema).min(1),
    description: z.string().trim().min(1).optional()
  })
]);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginManifestSchema = z.object({
  apiVersion: z.literal("memmy/v1"),
  id: PluginIdentifierSchema,
  name: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
  runtime: PluginRuntimeSchema,
  capabilities: z.array(PluginCapabilitySchema).min(1),
  permissions: z.array(PluginPermissionSchema),
  configSchema: JsonSchemaSchema.optional(),
  ui: z.record(z.string(), z.unknown()).optional()
}).superRefine((manifest, context) => {
  const ids = new Set<string>();
  for (const [index, capability] of manifest.capabilities.entries()) {
    if (ids.has(capability.id)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index, "id"],
        message: `Duplicate capability id: ${capability.id}`
      });
    }
    ids.add(capability.id);
  }
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const CapabilityCallSchema = z.object({
  callId: z.string().trim().min(1),
  pluginId: PluginIdentifierSchema,
  capabilityId: PluginIdentifierSchema,
  conversationId: z.string().trim().min(1),
  input: z.unknown(),
  deadline: z.string().datetime().optional()
});
export type CapabilityCall = z.infer<typeof CapabilityCallSchema>;

export const PluginInteractionRequestSchema = z.object({
  interactionId: z.string().trim().min(1),
  type: z.enum(["question", "approval", "file-input", "custom"]),
  payload: z.unknown(),
  responseSchema: JsonSchemaSchema.optional()
});
export type PluginInteractionRequest = z.infer<typeof PluginInteractionRequestSchema>;

export const PluginTaskSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  status: z.enum(["pending", "running", "completed", "failed"])
});
export type PluginTask = z.infer<typeof PluginTaskSchema>;

export const PluginArtifactRefSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  uri: z.string().trim().min(1)
});
export type PluginArtifactRef = z.infer<typeof PluginArtifactRefSchema>;

export const CapabilityEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    current: z.number().nonnegative(),
    total: z.number().positive().optional(),
    message: z.string().optional()
  }),
  z.object({ type: z.literal("task-list"), tasks: z.array(PluginTaskSchema) }),
  z.object({ type: z.literal("interaction"), request: PluginInteractionRequestSchema }),
  z.object({ type: z.literal("artifact"), artifact: PluginArtifactRefSchema }),
  z.object({ type: z.literal("result"), output: z.unknown() }),
  z.object({
    type: z.literal("error"),
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    retryable: z.boolean()
  })
]);
export type CapabilityEvent = z.infer<typeof CapabilityEventSchema>;

export const PluginStateSchema = z.enum([
  "installed",
  "pending_approval",
  "enabling",
  "active",
  "disabling",
  "disabled",
  "failed"
]);
export type PluginState = z.infer<typeof PluginStateSchema>;

export const InstalledPluginSchema = z.object({
  id: PluginIdentifierSchema,
  version: z.string().min(1),
  manifest: PluginManifestSchema,
  state: PluginStateSchema,
  approvedPermissions: z.array(PluginPermissionSchema),
  config: z.record(z.string(), z.unknown()),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

export const InstallPluginInputSchema = z.object({
  pluginId: PluginIdentifierSchema,
  version: z.string().trim().min(1).max(64).optional()
});
export type InstallPluginInput = z.infer<typeof InstallPluginInputSchema>;

export const UpdatePluginConfigInputSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(PluginIdentifierSchema, z.string()).optional()
});
export type UpdatePluginConfigInput = z.infer<typeof UpdatePluginConfigInputSchema>;

export const UpdatePluginPermissionsInputSchema = z.object({
  permissions: z.array(PluginPermissionSchema)
});
export type UpdatePluginPermissionsInput = z.infer<typeof UpdatePluginPermissionsInputSchema>;

export const InvokePluginCapabilityInputSchema = z.object({
  conversationId: z.string().trim().min(1),
  input: z.unknown()
});
export type InvokePluginCapabilityInput = z.infer<typeof InvokePluginCapabilityInputSchema>;

