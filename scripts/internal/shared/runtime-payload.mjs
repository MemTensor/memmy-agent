import path from "node:path";

// `doc` and `docs` are not skipped: the yaml package loads dist/doc/*.js at runtime.
const NON_RUNTIME_DIR = /^(?:test|tests|__tests__|__mocks__|example|examples|\.github|coverage|benchmark|benchmarks)$/i;
const NON_RUNTIME_DOC = /^(?:readme|changelog|history|contributing|code_of_conduct|security)(?:\.[a-z0-9]+)?$/i;
const NON_RUNTIME_FILE = /\.(?:map|d\.ts|d\.mts|d\.cts|ts|tsx|mts|cts|scss|sass|less|flow|tsbuildinfo|c|cc|cpp|h|hpp)$/i;
const NATIVE_PACKAGE = /(?:^|[-.])(darwin|linux|win32|windows|android|freebsd|openbsd)[-.](x64|arm64|ia32|arm|armv7l|universal|x86|mips64el|ppc64|s390x)(?:[-.](?:gnu|musl|msvc|eabi))?$/i;

const packageTarget = (options = {}) => {
  const raw = options.platform ?? process.platform;
  const platform = raw === "mas" || raw === "darwin" ? "darwin" : raw === "windows" ? "win32" : raw;
  return { platform, arch: options.arch ?? process.arch };
};

const isForeignNativeName = (name, target) => {
  const matched = NATIVE_PACKAGE.exec(name);
  if (!matched) return false;
  const platform = matched[1].toLowerCase() === "windows" ? "win32" : matched[1].toLowerCase();
  return platform !== target.platform || matched[2].toLowerCase() !== target.arch;
};

const shouldOmitPackagedDirectory = (relative, target) => {
  if (omitPackagedPayload(relative)) return true;
  const parts = String(relative).replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((part) => NON_RUNTIME_DIR.test(part) || isForeignNativeName(part, target))) return true;
  const napi = parts.indexOf("napi-v3");
  if (napi < 0 || !parts[napi + 1]) return false;
  const platform = parts[napi + 1].toLowerCase();
  const arch = (parts[napi + 2] ?? "").toLowerCase();
  if (["darwin", "linux", "win32"].includes(platform) && platform !== target.platform) return true;
  return ["x64", "arm64", "ia32"].includes(arch) && arch !== target.arch;
};

const omitNonRuntimePackagedRelative = (relative, options = {}) => {
  const target = packageTarget(options);
  const normalized = String(relative).replaceAll("\\", "/");
  if (shouldOmitPackagedDirectory(normalized, target)) return true;
  const name = path.posix.basename(normalized);
  if (NON_RUNTIME_DOC.test(name) || NON_RUNTIME_FILE.test(name)) return true;
  if (shouldOmitPackagedDirectory(path.posix.dirname(normalized), target)) return true;
  const extension = path.posix.extname(name).toLowerCase();
  if (target.platform === "win32" && (extension === ".dylib" || extension === ".so")) return true;
  if (target.platform === "darwin" && (extension === ".dll" || extension === ".exe")) return true;
  if (target.platform === "linux" && (extension === ".dylib" || extension === ".dll" || extension === ".exe")) return true;
  return false;
};

// Installer payload that the Node runtime does not load.
function omitPackagedPayload(relative) {
  const parts = String(relative ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const web = parts.indexOf("onnxruntime-web");
  if (web > 0 && parts[web - 1] === "node_modules") return true;
  const openclaw = parts.indexOf("openclaw");
  // yaml loads dist/doc/*.js. Only the OpenClaw documentation tree is unused.
  if (openclaw >= 0 && parts[openclaw + 1] === "docs") return true;
  const sqlite = parts.lastIndexOf("better-sqlite3");
  if (sqlite > 0 && parts[sqlite - 1] === "node_modules") {
    const rest = parts.slice(sqlite + 1).join("/");
    if (rest === "" || rest === "package.json" || rest === "lib" || rest.startsWith("lib/")) return false;
    if (rest === "build" || rest === "build/Release" || rest === "build/Release/better_sqlite3.node") return false;
    if (rest === "deps" || rest.startsWith("deps/") || rest === "src" || rest.startsWith("src/") || rest.startsWith("build/")) return true;
  }
  const tiktoken = parts.lastIndexOf("tiktoken");
  if (tiktoken > 0 && parts[tiktoken - 1] === "node_modules") {
    const child = parts[tiktoken + 1];
    // get_encoding() reads ranks from tiktoken_bg.wasm, not encoders/ or lite/.
    if (child === "encoders" || child === "lite") return true;
  }
  if (parts.at(-2) === "dist" && parts.at(-3) === "transformers" && parts.at(-4) === "@huggingface" && parts.at(-5) === "node_modules") {
    const file = parts.at(-1);
    if (file.endsWith(".map") || file.endsWith(".wasm")) return true;
    // Node resolves transformers.node.*; the browser bundles and their wasm are unused.
    if (/^transformers(?!\.node\.)/u.test(file)) return true;
  }
  return false;
}

export function includeRuntimePath(relative, options = {}) {
  const normalized = String(relative).replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".git" || part === ".DS_Store" || part === "__MACOSX" || part.startsWith("._"))) return false;
  if (["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(parts.at(-1))) return false;
  return !omitNonRuntimePackagedRelative(normalized, options);
}
