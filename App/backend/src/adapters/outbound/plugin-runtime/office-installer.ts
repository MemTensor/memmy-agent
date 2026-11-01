/** Host-owned, user-scoped installation of verified portable Office runtimes. */
import { z } from "zod";
import { createPortableRuntimeInstaller, extractPortableRuntime, PortableRuntimeManifestSchema, safeRuntimePath,
  type PortableRuntimeInstallerOptions, type InstalledPortableRuntime } from "./portable-installer.js";
export { safeRuntimePath };
export const OFFICE_TOOLS = ["soffice", "pdfinfo", "pdftoppm", "pdftotext"] as const;
export const OfficeRuntimeManifestSchema = PortableRuntimeManifestSchema.extend({
  format: z.literal("memmy-office-runtime-v1"),
  tools: z.object({ soffice: z.string().refine(safeRuntimePath), pdfinfo: z.string().refine(safeRuntimePath),
    pdftoppm: z.string().refine(safeRuntimePath), pdftotext: z.string().refine(safeRuntimePath) }).strict()
});
export type OfficeRuntimeManifest = z.infer<typeof OfficeRuntimeManifestSchema>;
export type InstalledOfficeRuntime = InstalledPortableRuntime;
export type OfficeRuntimeInstallerOptions = Omit<PortableRuntimeInstallerOptions, "kind" | "requiredTools">;
export interface OfficeRuntimeInstaller { ensure(platform: NodeJS.Platform, arch: string): Promise<InstalledOfficeRuntime> }
export function createOfficeRuntimeInstaller(options: OfficeRuntimeInstallerOptions): OfficeRuntimeInstaller {
  return createPortableRuntimeInstaller({ ...options, kind: "office", requiredTools: OFFICE_TOOLS });
}
export const extractOfficeRuntime = extractPortableRuntime;
