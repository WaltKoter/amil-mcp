import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "amil-koter.db");
const OLD_JSON = path.join(DATA_DIR, "mappings.json");

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

export function initDb(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS koter_refnets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      city_id     TEXT,
      city_name   TEXT,
      state_name  TEXT,
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_refnets_state ON koter_refnets(state_name);
    CREATE INDEX IF NOT EXISTS idx_refnets_name ON koter_refnets(name);

    CREATE TABLE IF NOT EXISTS mappings (
      amil_nome         TEXT NOT NULL,
      amil_cidade       TEXT NOT NULL,
      amil_estado       TEXT,
      koter_refnet_id   TEXT NOT NULL,
      koter_refnet_name TEXT,
      created_at        TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (amil_nome, amil_cidade)
    );

    CREATE TABLE IF NOT EXISTS last_network_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nome       TEXT NOT NULL,
      cidade     TEXT NOT NULL,
      estado     TEXT,
      categorias TEXT,
      search_params TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);

  migrateFromJson();
}

function migrateFromJson(): void {
  if (!fs.existsSync(OLD_JSON)) return;

  try {
    const raw = fs.readFileSync(OLD_JSON, "utf-8");
    const data = JSON.parse(raw);

    if (data.mappings?.length) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO mappings (amil_nome, amil_cidade, amil_estado, koter_refnet_id, koter_refnet_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const tx = db.transaction(() => {
        for (const m of data.mappings) {
          stmt.run(m.amilNome, m.amilCidade, m.amilEstado, m.koterRefnetId, m.koterRefnetName, m.createdAt);
        }
      });
      tx();
    }

    if (data.koterRefnets?.length) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO koter_refnets (id, name, city_id, city_name, state_name)
         VALUES (?, ?, ?, ?, ?)`
      );
      const tx = db.transaction(() => {
        for (const r of data.koterRefnets) {
          stmt.run(r.id, r.name, r.cityId, r.cityName, r.stateName);
        }
      });
      tx();
    }

    fs.renameSync(OLD_JSON, OLD_JSON + ".bak");
    console.log("[DB] Migrated data from mappings.json to SQLite");
  } catch (err: any) {
    console.error("[DB] Migration from JSON failed:", err.message);
  }
}
