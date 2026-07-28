import { addWebuiSessionBindingV104 } from "./migrations/v1.0.4/0001-add-webui-session-binding.js";
import { MigrationError, type MigrationDefinition } from "./types.js";

const STABLE_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MIGRATION_ID_PATTERN =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const migrations: readonly MigrationDefinition[] = [
  addWebuiSessionBindingV104,
];

function definitionError(message: string, migrationId: string | null = null): never {
  throw new MigrationError("migration_definition_invalid", message, { migrationId });
}

function semverParts(version: string): [number, number, number] {
  const match = STABLE_SEMVER_PATTERN.exec(version);
  if (!match) definitionError(`Invalid migration version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareOrder(
  left: { version: [number, number, number]; sequence: number },
  right: { version: [number, number, number]; sequence: number },
): number {
  for (let index = 0; index < left.version.length; index += 1) {
    const difference = left.version[index]! - right.version[index]!;
    if (difference !== 0) return difference;
  }
  return left.sequence - right.sequence;
}

export function validateMigrationRegistry(
  definitions: readonly MigrationDefinition[] = migrations,
): void {
  const ids = new Set<string>();
  let previous: { version: [number, number, number]; sequence: number } | null = null;

  for (const definition of definitions) {
    if (typeof definition.id !== "string" || !definition.id.trim()) {
      definitionError("Migration ID must be a non-empty string");
    }
    if (ids.has(definition.id)) {
      definitionError(`Duplicate migration ID: ${definition.id}`, definition.id);
    }
    ids.add(definition.id);

    if (
      typeof definition.introducedIn !== "string" ||
      !STABLE_SEMVER_PATTERN.test(definition.introducedIn)
    ) {
      definitionError(
        `Migration introducedIn must be a stable semantic version: ${definition.id}`,
        definition.id,
      );
    }
    if (definition.scope !== "agent-workspace") {
      definitionError(`Unsupported migration scope: ${definition.id}`, definition.id);
    }
    if (
      typeof definition.description !== "string" ||
      !definition.description.trim() ||
      typeof definition.up !== "function"
    ) {
      definitionError(`Incomplete migration definition: ${definition.id}`, definition.id);
    }

    const idMatch = MIGRATION_ID_PATTERN.exec(definition.id);
    if (!idMatch) {
      definitionError(`Invalid migration ID format: ${definition.id}`, definition.id);
    }
    const idVersion = idMatch[1]!;
    if (idVersion !== definition.introducedIn) {
      definitionError(
        `Migration ID version does not match introducedIn: ${definition.id}`,
        definition.id,
      );
    }
    const current = {
      version: semverParts(idVersion),
      sequence: Number(idMatch[2]),
    };
    if (current.sequence === 0) {
      definitionError(`Migration sequence must start at 0001: ${definition.id}`, definition.id);
    }
    if (previous && compareOrder(previous, current) >= 0) {
      definitionError(`Migration registry is out of order: ${definition.id}`, definition.id);
    }
    previous = current;
  }
}
