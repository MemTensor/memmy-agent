import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_HOOK_TIMEOUT_MS,
  withAgentHookTimeout,
  type AgentHook,
} from "./hook.js";

type HookFactory = () => AgentHook | Promise<AgentHook>;

export async function loadExternalAgentHooks(specifiers: string[]): Promise<AgentHook[]> {
  const hooks: AgentHook[] = [];
  for (const specifier of specifiers) {
    try {
      const hook = await withAgentHookTimeout(async () => {
        const module = await import(moduleTarget(specifier));
        if (typeof module.default !== "function") {
          throw new Error(`agent hook module '${specifier}' must default-export a hook factory`);
        }
        return (module.default as HookFactory)();
      }, AGENT_HOOK_TIMEOUT_MS, `external agent hook '${specifier}' initialization`);
      if (!hook || typeof hook !== "object") {
        throw new Error(`agent hook module '${specifier}' did not return a hook`);
      }
      hook.reraise = false;
      Object.defineProperty(hook, "externalHookSpecifier", {
        configurable: false,
        enumerable: false,
        value: specifier,
        writable: false,
      });
      hooks.push(hook);
    } catch (error) {
      console.error(`Unable to load external agent hook '${specifier}':`, error);
    }
  }
  return hooks;
}

function moduleTarget(specifier: string): string {
  if (specifier.startsWith("file:")) return new URL(specifier).href;
  if (path.isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier === "~" || specifier.startsWith("~/") || specifier.startsWith("./") || specifier.startsWith("../")) {
    throw new Error(`agent hook specifier '${specifier}' must be a package, absolute path, or file URL`);
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(specifier)) {
    throw new Error(`agent hook specifier '${specifier}' must use the file URL protocol`);
  }
  return specifier;
}
