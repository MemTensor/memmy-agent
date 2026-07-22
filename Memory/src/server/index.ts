#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createStorageBackend } from "../storage/backend.js";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { MemoryService } from "../service/memory-service.js";
import { listenMemoryHttpServer } from "./http.js";

const logger = createMemoryLogger("server");

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const options = parseServeArgs(argv);
    const { config, path: configPath } = loadMemmyConfig(options.configPath);
    const host = options.host ?? process.env.MEMMY_MEMORY_HOST ?? process.env.MEMORY_SERVICE_HOST ?? "127.0.0.1";
    const port = options.port ??
        numberEnv("MEMMY_MEMORY_PORT") ??
        numberEnv("MEMORY_SERVICE_PORT") ??
        18960;
    const sqlitePath = options.dbPath ?? config.storage.sqlitePath;
    logger.info("service.starting", {
        host,
        port,
        mode: config.storage.mode,
        storageBackend: config.storage.backend,
        sqlitePath,
        configPath
    });
    const serverLock = config.storage.backend === "openmem-cloud-rest"
        ? undefined
        : acquireSqliteServerLock({ sqlitePath, host, port });

    try {
        const backend = createStorageBackend({
            mode: config.storage.mode,
            backend: config.storage.backend,
            sqlitePath,
            endpoint: config.storage.endpoint,
            token: config.storage.token
        });
        const service = new MemoryService({
            backend,
            mode: config.storage.mode,
            configPath: options.configPath,
            config
        });
        const { url } = await listenMemoryHttpServer({
            service,
            host,
            port,
            onShutdownRequested: () => {
                setTimeout(() => process.kill(process.pid, "SIGTERM"), 0);
            },
            auth: config.storage.token
                ? { localServiceToken: config.storage.token }
                : { allowAnonymous: true }
        });
        if (configPath) {
            writeCurrentEndpoint(configPath, url);
        }

        logger.info("service.listening", {
            url,
            mode: config.storage.mode,
            storageBackend: config.storage.backend
        });
        await new Promise<void>(() => {
            // Keep the process alive while the HTTP server owns the service lifecycle.
        });
    } catch (error) {
        serverLock?.release();
        throw error;
    }
}

export interface SqliteServerLock {
    path: string;
    release(): void;
}

export function acquireSqliteServerLock(input: {
    sqlitePath?: string;
    host: string;
    port: number;
}): SqliteServerLock | undefined {
    if (!input.sqlitePath) return undefined;
    const sqlitePath = resolve(input.sqlitePath);
    const lockPath = `${sqlitePath}.server.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    return acquireLockFile(lockPath, {
        pid: process.pid,
        host: input.host,
        port: input.port,
        sqlitePath,
        startedAt: new Date().toISOString()
    });
}

function acquireLockFile(lockPath: string, payload: Record<string, unknown>): SqliteServerLock {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = openSync(lockPath, "wx");
            try {
                writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            } finally {
                closeSync(fd);
            }
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                try {
                    unlinkSync(lockPath);
                } catch {
                    // Stale lock cleanup is handled on the next startup.
                }
            };
            process.once("exit", release);
            return { path: lockPath, release };
        } catch (error) {
            if (!isNodeError(error) || error.code !== "EEXIST") {
                throw error;
            }
            const existing = readServerLock(lockPath);
            if (!existing || !isProcessAlive(existing.pid)) {
                try {
                    unlinkSync(lockPath);
                } catch (unlinkError) {
                    if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
                        throw unlinkError;
                    }
                }
                continue;
            }
            throw new Error(
                `Memory sqlite database is already served by pid ${existing.pid}` +
                `${existing.host && existing.port ? ` at ${existing.host}:${existing.port}` : ""}. ` +
                `Stop that process before starting another Memory server. Lock: ${lockPath}`
            );
        }
    }
    throw new Error(`failed to acquire Memory sqlite server lock: ${lockPath}`);
}

function readServerLock(lockPath: string): { pid?: unknown; host?: unknown; port?: unknown } | undefined {
    try {
        return JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; host?: unknown; port?: unknown };
    } catch {
        return undefined;
    }
}

function isProcessAlive(pid: unknown): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return isNodeError(error) && error.code === "EPERM";
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function parseServeArgs(argv: string[]): {
    configPath?: string;
    dbPath?: string;
    host?: string;
    port?: number;
} {
    const result: {
        configPath?: string;
        dbPath?: string;
        host?: string;
        port?: number;
    } = {};

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--config") {
            result.configPath = valueAfter(argv, index, arg);
            index += 1;
        } else if (arg?.startsWith("--config=")) {
            result.configPath = arg.slice("--config=".length);
        } else if (arg === "--db" || arg === "--sqlite-path") {
            result.dbPath = valueAfter(argv, index, arg);
            index += 1;
        } else if (arg?.startsWith("--db=")) {
            result.dbPath = arg.slice("--db=".length);
        } else if (arg?.startsWith("--sqlite-path=")) {
            result.dbPath = arg.slice("--sqlite-path=".length);
        } else if (arg === "--host") {
            result.host = valueAfter(argv, index, arg);
            index += 1;
        } else if (arg?.startsWith("--host=")) {
            result.host = arg.slice("--host=".length);
        } else if (arg === "--port") {
            result.port = parsePort(valueAfter(argv, index, arg));
            index += 1;
        } else if (arg?.startsWith("--port=")) {
            result.port = parsePort(arg.slice("--port=".length));
        }
    }

    return result;
}

function valueAfter(argv: string[], index: number, option: string): string {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}

function parsePort(value: string): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid port: ${value}`);
    }
    return port;
}

function numberEnv(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    return parsePort(value);
}

function writeCurrentEndpoint(configPath: string, endpoint: string): void {
    try {
        const root = existsSync(configPath)
            ? mutableRecord(parseYaml(readFileSync(configPath, "utf8")))
            : {};
        const memmyMemory = mutableRecord(root.memmyMemory);
        const storage = mutableRecord(memmyMemory.storage);
        if (storage.endpoint === endpoint) {
            return;
        }
        storage.endpoint = endpoint;
        memmyMemory.storage = storage;
        root.memmyMemory = memmyMemory;
        mkdirSync(dirname(configPath), { recursive: true });
        const content = stringifyYaml(root);
        writeFileSync(configPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    } catch (error) {
        logger.warn("config.endpoint_write_failed", {
            configPath,
            endpoint,
            ...memoryErrorFields(error)
        });
    }
}

function mutableRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>) }
        : {};
}

export function isDirectRun(argvPath = process.argv[1], modulePath = fileURLToPath(import.meta.url)): boolean {
    return argvPath !== undefined && realpathOrSelf(argvPath) === realpathOrSelf(modulePath);
}

function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

if (isDirectRun()) {
    main().catch((error) => {
        logger.error("service.fatal", memoryErrorFields(error));
        process.exitCode = 1;
    });
}
