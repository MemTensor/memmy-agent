#!/usr/bin/env node
import { mutateMemoryConfig } from "../config/writer.js";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createStorageBackend, type StorageBackend } from "../storage/backend.js";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { MemoryService } from "../service/memory-service.js";
import { listenMemoryHttpServer } from "./http.js";
import { loadCloudServiceEnv } from "../cli/load-env.js";
import { requestMemoryServiceRestart } from "./service-restart.js";
import { MEMORY_PROTOCOL_VERSION, MEMORY_SERVICE_VERSION } from "../version.js";

const logger = createMemoryLogger("server");

export async function main(argv = process.argv.slice(2)): Promise<void> {
    loadCloudServiceEnv();
    const options = parseServeArgs(argv);
    const { config, path: configPath } = loadMemmyConfig(options.configPath);
    const host = options.host ?? process.env.MEMMY_MEMORY_HOST ?? process.env.MEMORY_SERVICE_HOST ?? "127.0.0.1";
    assertLoopbackBindHost(host);
    const port = options.port ??
        numberEnv("MEMMY_MEMORY_PORT") ??
        numberEnv("MEMORY_SERVICE_PORT") ??
        18960;
    const sqlitePath = options.dbPath ?? config.storage.sqlitePath;
    const serviceHome = resolve(dirname(configPath), "memory-service");
    logger.info("service.starting", {
        host,
        port,
        mode: config.storage.mode,
        storageBackend: config.storage.backend,
        sqlitePath,
        configPath
    });
    const serviceLock = acquireUserServiceLock({ serviceHome, host, port });
    let sqliteLock: SqliteServerLock | undefined;
    let backend: StorageBackend | undefined;
    let server: Server | undefined;
    let requestShutdown: (() => void) | undefined;
    const shutdownRequested = new Promise<void>((resolveShutdown) => {
        requestShutdown = resolveShutdown;
    });
    const handleShutdownSignal = () => requestShutdown?.();

    try {
        sqliteLock = config.storage.backend === "openmem-cloud-rest"
            ? undefined
            : acquireSqliteServerLock({ sqlitePath, host, port });
        backend = createStorageBackend({
            mode: config.storage.mode,
            backend: config.storage.backend,
            sqlitePath,
            endpoint: config.storage.endpoint,
            token: config.storage.token
        });
        const service = new MemoryService({
            backend,
            mode: config.storage.mode,
            configPath,
            config
        });
        const listening = await listenMemoryHttpServer({
            service,
            host,
            port,
            timeZone: config.timeZone,
            onShutdownRequested: () => requestShutdown?.(),
            onRestartRequested: requestMemoryServiceRestart,
            auth: config.storage.token
                ? { localServiceToken: config.storage.token }
                : { allowAnonymous: true },
            configPath,
            startAgentSourceAutomation: true
        });
        server = listening.server;
        const { url } = listening;
        if (configPath) {
            await writeCurrentEndpoint(configPath, url);
        }
        writeRuntimeState(serviceHome, {
            pid: process.pid,
            endpoint: url,
            serviceVersion: MEMORY_SERVICE_VERSION,
            protocolVersion: MEMORY_PROTOCOL_VERSION,
            configPath,
            sqlitePath,
            startedAt: new Date().toISOString()
        });

        logger.info("service.listening", {
            url,
            mode: config.storage.mode,
            storageBackend: config.storage.backend
        });
        process.once("SIGINT", handleShutdownSignal);
        process.once("SIGTERM", handleShutdownSignal);
        await shutdownRequested;
    } finally {
        process.off("SIGINT", handleShutdownSignal);
        process.off("SIGTERM", handleShutdownSignal);
        if (server) {
            await closeHttpServer(server);
        }
        backend?.close();
        removeRuntimeState(serviceHome);
        sqliteLock?.release();
        serviceLock.release();
    }
}

async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
    });
}

export interface SqliteServerLock {
    path: string;
    release(): void;
}

export function acquireUserServiceLock(input: {
    serviceHome: string;
    host: string;
    port: number;
}): SqliteServerLock {
    const serviceHome = resolve(input.serviceHome);
    mkdirSync(serviceHome, { recursive: true });
    return acquireLockFile(join(serviceHome, "service.lock"), {
        pid: process.pid,
        host: input.host,
        port: input.port,
        serviceHome,
        serviceVersion: MEMORY_SERVICE_VERSION,
        protocolVersion: MEMORY_PROTOCOL_VERSION,
        startedAt: new Date().toISOString()
    });
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
                `Memory service is already served by pid ${existing.pid}` +
                `${existing.host && existing.port ? ` at ${existing.host}:${existing.port}` : ""}. ` +
                `Stop that process before starting another Memory server. Lock: ${lockPath}`
            );
        }
    }
    throw new Error(`failed to acquire Memory sqlite server lock: ${lockPath}`);
}

function writeRuntimeState(serviceHome: string, state: Record<string, unknown>): void {
    mkdirSync(serviceHome, { recursive: true });
    const path = join(serviceHome, "runtime.json");
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
}

function removeRuntimeState(serviceHome: string): void {
    const path = join(serviceHome, "runtime.json");
    try {
        const state = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
        if (state.pid === process.pid) unlinkSync(path);
    } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            logger.warn("runtime_state.remove_failed", { path, ...memoryErrorFields(error) });
        }
    }
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

export function assertLoopbackBindHost(host: string): void {
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
        throw new Error(`Memory service must listen on a loopback address, received: ${host}`);
    }
}

export async function writeCurrentEndpoint(configPath: string, endpoint: string): Promise<void> {
    try {
        await mutateMemoryConfig(configPath, (root) => {
            const memmyMemory = mutableRecord(root.memmyMemory);
            const storage = mutableRecord(memmyMemory.storage);
            storage.endpoint = endpoint;
            memmyMemory.storage = storage;
            root.memmyMemory = memmyMemory;
        });
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
