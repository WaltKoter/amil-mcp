import { getDb } from "./db.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RefnetMapping {
  amilNome: string;
  amilCidade: string;
  amilEstado: string;
  koterRefnetId: string;
  koterRefnetName: string;
  createdAt: string;
}

export interface KoterRefnet {
  id: string;
  name: string;
  cityId: string;
  cityName: string;
  stateName: string;
}

export interface NetworkProvider {
  nome: string;
  cidade: string;
  estado: string;
  categorias: string[];
}

export interface AutoMatchResult {
  amilNome: string;
  amilCidade: string;
  bestMatch: KoterRefnet | null;
  confidence: number;
  alternatives: Array<{ refnet: KoterRefnet; confidence: number }>;
}

// ─── Mappings CRUD ──────────────────────────────────────────────────────────

export function getAllMappings(estado?: string): RefnetMapping[] {
  const db = getDb();
  if (estado) {
    return db
      .prepare(
        `SELECT amil_nome as amilNome, amil_cidade as amilCidade, amil_estado as amilEstado,
                koter_refnet_id as koterRefnetId, koter_refnet_name as koterRefnetName, created_at as createdAt
         FROM mappings WHERE UPPER(amil_estado) = UPPER(?)`
      )
      .all(estado) as RefnetMapping[];
  }
  return db
    .prepare(
      `SELECT amil_nome as amilNome, amil_cidade as amilCidade, amil_estado as amilEstado,
              koter_refnet_id as koterRefnetId, koter_refnet_name as koterRefnetName, created_at as createdAt
       FROM mappings`
    )
    .all() as RefnetMapping[];
}

export function getMappingByKey(nome: string, cidade: string): RefnetMapping | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT amil_nome as amilNome, amil_cidade as amilCidade, amil_estado as amilEstado,
              koter_refnet_id as koterRefnetId, koter_refnet_name as koterRefnetName, created_at as createdAt
       FROM mappings WHERE amil_nome = ? AND amil_cidade = ?`
    )
    .get(nome, cidade) as RefnetMapping | undefined;
  return row || null;
}

export function upsertMapping(mapping: RefnetMapping): RefnetMapping {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mappings (amil_nome, amil_cidade, amil_estado, koter_refnet_id, koter_refnet_name)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    mapping.amilNome,
    mapping.amilCidade,
    mapping.amilEstado,
    mapping.koterRefnetId,
    mapping.koterRefnetName
  );
  return mapping;
}

export function deleteMapping(nome: string, cidade: string): boolean {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM mappings WHERE amil_nome = ? AND amil_cidade = ?`)
    .run(nome, cidade);
  return result.changes > 0;
}

// ─── Koter Refnets ─────────────────────────────────────────────────────────

export function searchKoterRefnets(
  query: string,
  stateName?: string,
  cityName?: string,
  limit = 20
): KoterRefnet[] {
  const db = getDb();
  const q = query.toUpperCase().trim().replace(/\s+/g, " ");
  if (!q) return [];

  let sql = `SELECT id, name, city_id as cityId, city_name as cityName, state_name as stateName FROM koter_refnets WHERE 1=1`;
  const params: any[] = [];

  if (stateName) {
    // Amil: "RIO DE JANEIRO" (upper, no accents), Koter: "Rio de Janeiro"
    // Resolve by checking distinct states in DB and matching with accent-stripped comparison
    const allStates = db
      .prepare(`SELECT DISTINCT state_name FROM koter_refnets`)
      .all() as Array<{ state_name: string }>;
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    const inputNorm = norm(stateName);
    const matchingStates = allStates.filter((s) => norm(s.state_name) === inputNorm).map((s) => s.state_name);
    if (matchingStates.length > 0) {
      sql += ` AND state_name IN (${matchingStates.map(() => "?").join(",")})`;
      params.push(...matchingStates);
    } else {
      sql += ` AND UPPER(state_name) LIKE ?`;
      params.push(`%${inputNorm}%`);
    }
  }
  if (cityName) {
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    const inputNorm = norm(cityName);
    const allCities = db
      .prepare(`SELECT DISTINCT city_name FROM koter_refnets`)
      .all() as Array<{ city_name: string }>;
    const matchingCities = allCities.filter((c) => norm(c.city_name) === inputNorm).map((c) => c.city_name);
    if (matchingCities.length > 0) {
      sql += ` AND city_name IN (${matchingCities.map(() => "?").join(",")})`;
      params.push(...matchingCities);
    }
  }

  // Pre-filter with LIKE for performance
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length > 0) {
    sql += ` AND (` + tokens.map(() => `UPPER(name) LIKE ?`).join(" OR ") + `)`;
    for (const t of tokens) params.push(`%${t}%`);
  }

  const candidates = db.prepare(sql).all(...params) as KoterRefnet[];

  // Score in JS for better ranking
  const scored = candidates.map((r) => {
    const name = r.name.toUpperCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q)) score = 80;
    else if (q.includes(name)) score = 70;
    else {
      const qTokens = q.split(/\s+/);
      const nTokens = name.split(/\s+/);
      const matches = qTokens.filter((t) =>
        nTokens.some((nt) => nt.includes(t) || t.includes(nt))
      );
      score = (matches.length / Math.max(qTokens.length, 1)) * 60;
    }
    return { refnet: r, score };
  });

  return scored
    .filter((s) => s.score > 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.refnet);
}

export function importKoterRefnets(refnets: KoterRefnet[]): number {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO koter_refnets (id, name, city_id, city_name, state_name, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, city_id=excluded.city_id,
       city_name=excluded.city_name, state_name=excluded.state_name, updated_at=datetime('now')`
  );
  const countBefore = (db.prepare(`SELECT COUNT(*) as c FROM koter_refnets`).get() as any).c;
  const tx = db.transaction(() => {
    for (const r of refnets) {
      upsert.run(r.id, r.name, r.cityId, r.cityName, r.stateName);
    }
  });
  tx();
  const countAfter = (db.prepare(`SELECT COUNT(*) as c FROM koter_refnets`).get() as any).c;
  return countAfter - countBefore;
}

export function getKoterRefnetStats(): { total: number; byState: Record<string, number> } {
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) as c FROM koter_refnets`).get() as any).c;
  const rows = db
    .prepare(`SELECT state_name as state, COUNT(*) as cnt FROM koter_refnets GROUP BY state_name ORDER BY cnt DESC`)
    .all() as Array<{ state: string; cnt: number }>;
  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.state] = r.cnt;
  return { total, byState };
}

// ─── Last Network Results ───────────────────────────────────────────────────

export function saveNetworkResults(
  providers: NetworkProvider[],
  searchParams: Record<string, string>
): void {
  const db = getDb();
  const paramsJson = JSON.stringify(searchParams);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM last_network_results`).run();
    const stmt = db.prepare(
      `INSERT INTO last_network_results (nome, cidade, estado, categorias, search_params)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of providers) {
      stmt.run(p.nome, p.cidade, p.estado, JSON.stringify(p.categorias), paramsJson);
    }
  });
  tx();
}

export function getLastNetworkResults(): {
  providers: NetworkProvider[];
  searchParams: Record<string, string> | null;
} {
  const db = getDb();
  const rows = db
    .prepare(`SELECT nome, cidade, estado, categorias, search_params FROM last_network_results ORDER BY id`)
    .all() as Array<{
    nome: string;
    cidade: string;
    estado: string;
    categorias: string;
    search_params: string;
  }>;

  if (!rows.length) return { providers: [], searchParams: null };

  const providers = rows.map((r) => ({
    nome: r.nome,
    cidade: r.cidade,
    estado: r.estado,
    categorias: JSON.parse(r.categorias || "[]"),
  }));

  let searchParams = null;
  try {
    searchParams = JSON.parse(rows[0].search_params);
  } catch {}

  return { providers, searchParams };
}

// ─── Auto-match ─────────────────────────────────────────────────────────────

const NOISE_WORDS = [
  "HOSPITAL", "HOSP", "HOSP.", "CLINICA", "CLÍNICA", "LABORATORIO",
  "LABORATÓRIO", "LAB", "LAB.", "CENTRO", "INST", "INSTITUTO",
  "S/A", "SA", "LTDA", "ME", "EIRELI", "EPP", "S.A.", "S.A",
  "UNIDADE", "FILIAL", "MATRIZ",
];

function normalizeName(name: string): string {
  let n = name.toUpperCase().trim();
  n = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const w of NOISE_WORDS) {
    n = n.replace(new RegExp("\\b" + w.replace(/\./g, "\\.") + "\\b", "g"), "");
  }
  return n.replace(/\s+/g, " ").trim();
}

function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const tokensA = na.split(/\s+/);
  const tokensB = nb.split(/\s+/);
  const matches = tokensA.filter((t) =>
    tokensB.some((bt) => bt === t || bt.includes(t) || t.includes(bt))
  );
  return matches.length / Math.max(tokensA.length, tokensB.length);
}

export function autoMatchProviders(
  providers: Array<{ nome: string; cidade: string; estado: string }>,
  threshold = 0.5
): AutoMatchResult[] {
  const db = getDb();
  const results: AutoMatchResult[] = [];

  for (const p of providers) {
    const existing = getMappingByKey(p.nome, p.cidade);
    if (existing) continue;

    // Get candidates from DB filtered by state
    const stateRefnets = db
      .prepare(
        `SELECT id, name, city_id as cityId, city_name as cityName, state_name as stateName
         FROM koter_refnets WHERE UPPER(state_name) LIKE ?`
      )
      .all(`%${p.estado.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").substring(0, 10)}%`) as KoterRefnet[];

    const scored = stateRefnets.map((r) => {
      let conf = similarity(p.nome, r.name);
      const cityMatch =
        r.cityName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ===
        p.cidade.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (cityMatch) conf = Math.min(1, conf + 0.15);
      return { refnet: r, confidence: conf };
    });

    scored.sort((a, b) => b.confidence - a.confidence);
    const top = scored.filter((s) => s.confidence >= threshold).slice(0, 5);

    results.push({
      amilNome: p.nome,
      amilCidade: p.cidade,
      bestMatch: top.length > 0 ? top[0].refnet : null,
      confidence: top.length > 0 ? top[0].confidence : 0,
      alternatives: top,
    });
  }

  return results;
}

// ─── Export ─────────────────────────────────────────────────────────────────

export function exportForKoter(
  providers: Array<{ nome: string; cidade: string }>
): Array<{ refnetId: string }> {
  const result: Array<{ refnetId: string }> = [];
  const seen = new Set<string>();

  for (const p of providers) {
    const mapping = getMappingByKey(p.nome, p.cidade);
    if (mapping && !seen.has(mapping.koterRefnetId)) {
      result.push({ refnetId: mapping.koterRefnetId });
      seen.add(mapping.koterRefnetId);
    }
  }

  return result;
}
