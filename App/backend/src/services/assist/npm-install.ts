/**
 * 不依赖 npm 与 node 的包装安装：从 npm registry 取 tarball，解到指定目录。
 *
 * <p>为什么不用 `npm install`：打包后的 Memmy 里没有 npm，也不能保证用户机器上有 node。
 * 执行协助需要的那三个适配器（Claude Code、Codex、Pi）的代码加起来只有几 MB，版本由我们自己钉住，
 * 因此这里只做「解析版本、下载、校验、解包」四件事，不处理 npm 脚本、bin 链接、lock 这些能力。</p>
 *
 * <p>引擎本体（`@openai/codex`、`@anthropic-ai/claude-agent-sdk` 的平台包）动辄几百 MB，
 * 一律跳过：执行时用它自己装在本机的那一份（见 {@link ./engines}），把路径传给适配器。</p>
 *
 * <p>失败一律抛出带原因的错误，由调用方转成给双方看的失败说明；这里不吞错、不重试。</p>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** npm registry；测试与本机私有 registry 都可以换。 */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface PackageRequest {
  /** 包名，可以是 scoped（`@agentclientprotocol/codex-acp`）。 */
  name: string;
  /** `1.2.3`、`^1.2.3`、`~1.2.3` 或 `*`；精确版本直接取，范围按 registry 里的最高版本解析。 */
  version: string;
}

export interface InstallPackagesOptions {
  /** 装到哪里：包会落在 `<root>/node_modules/<name>`。 */
  root: string;
  /** 要装的包（含传递依赖，由这里自己解析）。 */
  packages: readonly PackageRequest[];
  /** 由本机提供的包：不下载，也不要求它存在（引擎本体走这条路）。 */
  skip?: readonly string[];
  /** 每装完一个包回报一次，界面上可以说清正在准备什么。 */
  onInstalled?: (name: string, version: string) => void;
  registry?: string;
  /** 测试可注入；默认用全局 fetch。 */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface InstallPackagesResult {
  installed: PackageRequest[];
  /** 跳过的包，调用方用它确认引擎由本机提供。 */
  skipped: string[];
}

/** registry 里一个版本的元数据，只取用得到的字段。 */
interface VersionMetadata {
  tarball: string;
  integrity: string | null;
  dependencies: Record<string, string>;
}

function registryBase(registry: string): string {
  return registry.replace(/\/+$/u, "");
}

function packagePath(name: string): string {
  return name.replace("/", "%2f");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 精简 metadata（install-v1）里的版本表：比默认格式小一个量级。 */
async function readPackument(
  registry: string,
  name: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<{ latest: string | null; versions: string[]; json: Record<string, unknown> }> {
  const response = await fetchImpl(`${registryBase(registry)}/${packagePath(name)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error(`${name} 取不到版本信息（HTTP ${response.status}）`);
  const data = await response.json() as { "dist-tags"?: { latest?: unknown }; versions?: unknown };
  const versions = isRecord(data.versions) ? Object.keys(data.versions) : [];
  const latest = typeof data["dist-tags"]?.latest === "string" ? data["dist-tags"].latest : null;
  return { latest, versions, json: isRecord(data.versions) ? data.versions : {} };
}

/** 三段版本比较；预发布后缀按「比同号正式版小」处理就够了。 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  const preA = left.includes("-");
  const preB = right.includes("-");
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

/**
 * 判断版本是否满足一个范围。
 *
 * <p>只实现 registry 上这批包实际会写的写法：精确版本、`^`、`~`、`>`/`>=`、`*`。
 * `||` 这类组合范围退回「取最高版本」——这些适配器的依赖里没有用到，用不到的能力不写猜测实现。</p>
 */
export function satisfiesRange(version: string, range: string): boolean {
  const value = range.trim();
  if (!value || value === "*" || value === "latest" || value.includes("||")) return true;
  if (value.includes(" - ")) {
    const [from, to] = value.split(" - ");
    return compareVersions(version, from!) >= 0 && compareVersions(version, to!) <= 0;
  }
  const match = /^(>=|>|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(value);
  if (!match) return true;
  const [, operator, major, minor, patch] = match;
  const wanted = `${major}.${minor ?? "0"}.${patch ?? "0"}`;
  if (!operator) return compareVersions(version, wanted) === 0;
  if (operator === ">=") return compareVersions(version, wanted) >= 0;
  if (operator === ">") return compareVersions(version, wanted) > 0;
  // `^` 与 `~` 的差别只在次版本能不能涨：`^0.x` 与 `~0.x` 都锁在 0.minor，
  // `^1.2` 允许涨次版本，`~1.2` 不允许。
  const parsed = version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (compareVersions(version, wanted) < 0) return false;
  if (operator === "~") return parsed[0] === Number(major) && parsed[1] === Number(minor ?? 0);
  const majorNumber = Number(major);
  if (majorNumber > 0) return parsed[0] === majorNumber;
  // `^0.x.y`：只锁到 x，`^0.0.z`：只锁到 z。
  if (Number(minor ?? 0) > 0) return parsed[0] === 0 && parsed[1] === Number(minor);
  return parsed[0] === 0 && parsed[1] === 0 && parsed[2] === Number(patch ?? 0);
}

/** 从候选版本里挑出满足范围的最高正式版。 */
export function pickVersion(versions: readonly string[], range: string): string | null {
  const stable = versions.filter((version) => !version.includes("-"));
  const matched = stable.filter((version) => satisfiesRange(version, range));
  if (!matched.length) return null;
  return matched.reduce((best, version) => (compareVersions(version, best) > 0 ? version : best));
}

async function readVersion(
  registry: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<VersionMetadata> {
  const response = await fetchImpl(`${registryBase(registry)}/${packagePath(name)}/${version}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error(`${name}@${version} 取不到元数据（HTTP ${response.status}）`);
  const data = await response.json() as { dist?: { tarball?: unknown; integrity?: unknown }; dependencies?: unknown };
  const tarball = typeof data.dist?.tarball === "string" ? data.dist.tarball : "";
  if (!tarball) throw new Error(`${name}@${version} 没有下载地址`);
  return {
    tarball,
    integrity: typeof data.dist?.integrity === "string" ? data.dist.integrity : null,
    dependencies: isRecord(data.dependencies) ? data.dependencies as Record<string, string> : {}
  };
}

/**
 * 把要装的包连同传递依赖解析成一棵平铺清单。
 *
 * <p>平铺（都装在同一个 `node_modules` 下）是 npm 的经典做法，Node 从包目录向上找就能命中。
 * 同一个包被两个版本要求时取更高的那个：这批依赖都是小工具库，差异不影响接口。</p>
 */
export async function resolveInstallPlan(options: {
  packages: readonly PackageRequest[];
  skip?: readonly string[];
  registry?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PackageRequest[]> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const skip = new Set(options.skip ?? []);
  const resolved = new Map<string, string>();
  const queue: PackageRequest[] = [...options.packages];

  while (queue.length) {
    const request = queue.shift()!;
    if (skip.has(request.name)) continue;
    options.signal?.throwIfAborted();
    let version = request.version.trim();
    if (!/^\d+\.\d+\.\d+/u.test(version)) {
      const packument = await readPackument(registry, request.name, fetchImpl, options.signal);
      const picked = pickVersion(packument.versions, version) ?? packument.latest;
      if (!picked) throw new Error(`${request.name} 没有满足 ${request.version} 的版本`);
      version = picked;
    }
    const previous = resolved.get(request.name);
    if (previous && compareVersions(previous, version) >= 0) continue;
    resolved.set(request.name, version);
    const meta = await readVersion(registry, request.name, version, fetchImpl, options.signal);
    for (const [name, range] of Object.entries(meta.dependencies)) {
      if (skip.has(name) || name.startsWith("@types/")) continue;
      queue.push({ name, version: range });
    }
  }

  // 依赖先装、被依赖的后装：清单按名字排序即可，解包不执行任何脚本，顺序只影响日志可读性。
  return [...resolved.entries()]
    .map(([name, version]) => ({ name, version }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

/** 校验 registry 给的 sha512：下载到的字节被换过时不能装进去。 */
function verifyIntegrity(bytes: Buffer, integrity: string | null, label: string): void {
  if (!integrity) return;
  const sha512 = integrity.split(/\s+/u).find((part) => part.startsWith("sha512-"));
  if (!sha512) return;
  const expected = sha512.slice("sha512-".length);
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== expected) throw new Error(`${label} 校验不通过（下载内容与 registry 记录不一致）`);
}

/** 一个 tar 条目：只保留解包需要的字段。 */
interface TarEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  body: Buffer;
}

/**
 * 解析 tar（ustar + pax）：npm 打出来的包用这套格式。
 *
 * <p>只处理这里真的会出现的类型：普通文件、目录、符号链接、以及 pax 的扩展头（超长路径）。
 * 其余类型跳过，出问题会作为解包失败报出来，不静默丢文件。</p>
 */
export function readTarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  /** pax 头给下一个条目用的长路径。 */
  let pendingName: string | null = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    // 全零块是归档结束标记。
    if (header.every((byte) => byte === 0)) break;
    const rawName = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0) || "0";
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) throw new Error("压缩包的 tar 结构不完整");
    const body = archive.subarray(bodyStart, bodyEnd);
    if (type === "x") {
      // pax 扩展头：正文形如「<长度> path=<值>\n」。
      const match = /\d+ path=([^\n]*)\n/u.exec(body.toString("utf8"));
      if (match?.[1]) pendingName = match[1];
    } else if (type !== "g") {
      const name = pendingName ?? rawName;
      pendingName = null;
      if (name) {
        entries.push({
          name,
          type: type === "2" ? "symlink" : type === "5" ? "dir" : "file",
          body
        });
      }
    }
    // 每个条目占整数个 512 字节块。
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end < 0 ? slice : slice.subarray(0, end)).toString("utf8");
}

function readOctal(header: Buffer, start: number, length: number): number {
  const text = readString(header, start, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** 把 npm 包解开：条目都以 `package/` 开头，落到目标目录时去掉这一层。 */
export function extractPackage(archive: Buffer, target: string): void {
  // 先清掉旧目录：装一半失败时不能留下半套文件，让下一次看起来「已装好」。
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const entry of readTarEntries(archive)) {
    const relative = entry.name.startsWith("package/") ? entry.name.slice("package/".length) : entry.name;
    if (!relative) continue;
    // 防目录穿越：包内容不能写到目标目录之外。
    if (relative.split("/").includes("..")) continue;
    const path = join(target, relative);
    if (entry.type === "dir") {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (entry.type === "symlink") {
      // 包内链接只在包内活动，按原样写出来（Windows 上没有权限时忽略，不影响入口文件）。
      try {
        symlinkSync(entry.body.toString("utf8"), path);
      } catch {
        // Windows 上建符号链接要开发者模式或管理员权限：包内链接不影响我们用的入口。
      }
      continue;
    }
    writeFileSync(path, entry.body);
  }
}

/** 读一个已安装包的版本；没装时返回 null。 */
export function installedVersion(root: string, name: string): string | null {
  const file = join(root, "node_modules", name, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 按清单安装：解析依赖、逐个下载解包。
 * 已经装好同一版本的跳过，不重复下载。
 */
export async function installPackages(options: InstallPackagesOptions): Promise<InstallPackagesResult> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const plan = await resolveInstallPlan({
    packages: options.packages,
    ...(options.skip ? { skip: options.skip } : {}),
    registry,
    fetch: fetchImpl,
    ...(options.signal ? { signal: options.signal } : {})
  });
  const installed: PackageRequest[] = [];
  const skipped = [...(options.skip ?? [])];

  for (const request of plan) {
    if (installedVersion(options.root, request.name) === request.version) continue;
    const meta = await readVersion(registry, request.name, request.version, fetchImpl, options.signal);
    options.signal?.throwIfAborted();
    const response = await fetchImpl(meta.tarball, {
      headers: { accept: "application/octet-stream" },
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (!response.ok) throw new Error(`${request.name}@${request.version} 下载失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyIntegrity(bytes, meta.integrity, `${request.name}@${request.version}`);
    extractPackage(gunzipSync(bytes), join(options.root, "node_modules", request.name));
    installed.push(request);
    options.onInstalled?.(request.name, request.version);
  }
  return { installed, skipped };
}
