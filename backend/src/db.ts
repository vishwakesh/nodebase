import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';

for (const dir of [path.dirname(config.databasePath), config.storageRoot, config.botRoot, config.blobRoot, config.backupRoot]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
if (!fs.existsSync(migrationsDir)) throw new Error(`Database migrations directory was not found: ${migrationsDir}`);
const migrationFiles = fs.readdirSync(migrationsDir).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
for (const version of migrationFiles) {
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version);
  if (applied) continue;
  const sql = fs.readFileSync(path.join(migrationsDir, version), 'utf8');
  const migrate = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version,applied_at) VALUES (?,?)').run(version, new Date().toISOString());
  });
  migrate();
}

export function nowIso() { return new Date().toISOString(); }
export function addActivity(type: string, message: string, detail?: unknown) {
  db.prepare('INSERT INTO activity (id,type,message,detail_json,created_at) VALUES (?,?,?,?,?)')
    .run(cryptoRandomId(), type, message, detail === undefined ? null : JSON.stringify(detail), nowIso());
}
export function cryptoRandomId() { return crypto.randomUUID(); }
