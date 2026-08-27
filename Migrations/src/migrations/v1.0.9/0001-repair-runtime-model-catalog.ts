import { runRuntimeModelCatalogMigration } from "../v1.0.7/0001-normalize-runtime-model-catalog.js";
import type { MigrationDefinition } from "../../types.js";

const MIGRATION_ID = "v1.0.9/0001-repair-runtime-model-catalog";

export const repairRuntimeModelCatalogV109: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.9",
  scope: "runtime-config",
  description: "Repair runtime model catalogs skipped by the original migration",
  up: (context) => runRuntimeModelCatalogMigration(context, MIGRATION_ID),
};
