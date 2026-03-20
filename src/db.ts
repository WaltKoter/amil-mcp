import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://amilpostgress:Gaminha1@16516156106216121121@koter_amil-postgress:5432/amil-postgress?sslmode=disable";

// For local dev, use external port
const LOCAL_DATABASE_URL =
  "postgres://amilpostgress:Gaminha1@16516156106216121121@147.93.33.67:5433/amil-postgress?sslmode=disable";

let pool: pg.Pool;

export function getPool(): pg.Pool {
  return pool;
}

// Sync helper for queries that need to run synchronously (migration from better-sqlite3)
// All callers must be updated to use async
export async function query(text: string, params?: any[]): Promise<pg.QueryResult<any>> {
  return pool.query(text, params);
}

export async function initDb(): Promise<void> {
  const connStr = process.env.DATABASE_URL || (process.env.NODE_ENV === "production" ? DATABASE_URL : LOCAL_DATABASE_URL);

  pool = new pg.Pool({
    connectionString: connStr,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("[DB] PostgreSQL connected");
  } finally {
    client.release();
  }

  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS koter_refnets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      city_id     TEXT,
      city_name   TEXT,
      state_name  TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_refnets_state ON koter_refnets(state_name);
    CREATE INDEX IF NOT EXISTS idx_refnets_name ON koter_refnets(name);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mappings (
      amil_nome         TEXT NOT NULL,
      amil_cidade       TEXT NOT NULL,
      amil_estado       TEXT,
      koter_refnet_id   TEXT NOT NULL,
      koter_refnet_name TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (amil_nome, amil_cidade)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS last_network_results (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      cidade     TEXT NOT NULL,
      estado     TEXT,
      categorias TEXT,
      search_params TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS all_providers (
      nome       TEXT NOT NULL,
      cidade     TEXT NOT NULL,
      estado     TEXT NOT NULL,
      tipo_rede  TEXT NOT NULL DEFAULT 'Hospitais',
      linhas     TEXT DEFAULT '[]',
      categorias TEXT DEFAULT '[]',
      modalidades TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (nome, cidade, tipo_rede)
    );
    CREATE INDEX IF NOT EXISTS idx_all_prov_estado ON all_providers(estado);
    CREATE INDEX IF NOT EXISTS idx_all_prov_tipo ON all_providers(tipo_rede);
  `);

  console.log("[DB] Tables ready");
}
