/** Backend ESLint configuration. */
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

const SRC = "src";
const INBOUND_ADAPTERS = `${SRC}/adapters/inbound`;
const OUTBOUND_ADAPTERS = `${SRC}/adapters/outbound`;
const SERVICES = `${SRC}/services`;
const PERMISSION = `${SRC}/permission`;
const INFRASTRUCTURE = `${SRC}/infrastructure`;
const OUTBOUND_ADAPTER_NAMES = [
  "agent-adapter",
  "agent-source",
  "cloud-client",
  "memory-client",
  "skill-writer"
];

/** Creates one import/no-restricted-paths zone. */
function createBoundaryZone(target, from, message) {
  return {
    // The target is the importing directory constrained by this rule.
    target,
    // The source directory cannot be imported directly by the target.
    from,
    // The message explains the architecture boundary in lint output.
    message
  };
}

/** Creates zones that prevent an outbound adapter from depending on sibling outbound adapters. */
function createOutboundSiblingZones(adapterName) {
  const adapterDirectory = `${OUTBOUND_ADAPTERS}/${adapterName}`;

  return OUTBOUND_ADAPTER_NAMES.filter((otherAdapterName) => otherAdapterName !== adapterName).map((otherAdapterName) =>
    createBoundaryZone(
      adapterDirectory,
      `${OUTBOUND_ADAPTERS}/${otherAdapterName}`,
      "出站适配器之间不能直接互相调用；需要由 services 层编排。"
    )
  );
}

const boundaryZones = [
  createBoundaryZone(
    INBOUND_ADAPTERS,
    OUTBOUND_ADAPTERS,
    "入站适配器不能直接调用出站适配器；需要经过 services 层。"
  ),
  createBoundaryZone(
    INBOUND_ADAPTERS,
    INFRASTRUCTURE,
    "入站适配器不能直接访问本地基础设施；需要经过 services 层。"
  ),
  createBoundaryZone(SERVICES, INBOUND_ADAPTERS, "services 层不能反向依赖入站适配器。"),
  createBoundaryZone(PERMISSION, `${SRC}/adapters`, "permission 层不能依赖 adapters。"),
  createBoundaryZone(PERMISSION, SERVICES, "permission 层不能依赖 services。"),
  createBoundaryZone(INFRASTRUCTURE, `${SRC}/adapters`, "infrastructure 层不能依赖 adapters。"),
  createBoundaryZone(INFRASTRUCTURE, SERVICES, "infrastructure 层不能依赖 services。"),
  createBoundaryZone(INFRASTRUCTURE, PERMISSION, "infrastructure 层不能依赖 permission。"),
  createBoundaryZone(OUTBOUND_ADAPTERS, INBOUND_ADAPTERS, "出站适配器不能依赖入站适配器。"),
  createBoundaryZone(OUTBOUND_ADAPTERS, SERVICES, "出站适配器不能依赖 services。"),
  createBoundaryZone(OUTBOUND_ADAPTERS, PERMISSION, "出站适配器不能依赖 permission。"),
  createBoundaryZone(OUTBOUND_ADAPTERS, INFRASTRUCTURE, "出站适配器不能依赖 infrastructure。"),
  ...OUTBOUND_ADAPTER_NAMES.flatMap(createOutboundSiblingZones)
];

export default tseslint.config({
  ignores: ["dist/**", "node_modules/**", "coverage/**"],
  files: ["src/**/*.ts", "vitest.config.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      sourceType: "module"
    }
  },
  plugins: {
    import: importPlugin
  },
  settings: {
    "import/resolver": {
      typescript: {
        project: "./tsconfig.json"
      }
    }
  },
  rules: {
    "import/no-restricted-paths": [
      "error",
      {
        basePath: import.meta.dirname,
        zones: boundaryZones
      }
    ]
  }
});
