import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface OpenDatabaseOptions {
  databasePath?: string;
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const databasePath = options.databasePath ?? resolveDefaultDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);

  return db;
}

export function resolveDefaultDatabasePath(): string {
  if (process.env.MEMMY_APP_DB_PATH) {
    return process.env.MEMMY_APP_DB_PATH;
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Memmy", "app.sqlite");
  }

  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Memmy", "app.sqlite");
  }

  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Memmy", "app.sqlite");
}
