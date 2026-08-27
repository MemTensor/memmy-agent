/** Migrate module. */
import { createAppStateStore } from "../index.js";

const store = createAppStateStore();

try {
  const rows = store.db.prepare("SELECT name, applied_at FROM _migrations ORDER BY name").all();
  process.stdout.write(`Memmy App DB migrated at ${store.databasePath}\n`);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} finally {
  store.close();
}
