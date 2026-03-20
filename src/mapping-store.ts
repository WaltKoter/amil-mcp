import { getDb } from "./db.js";
import { searchKoterRefnets as searchKoterLive, KoterRefnetResult } from "./koter-client.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RefnetMapping {
  amilNome: string;
  amilCidade: string;
  amilEstado: string;
  koterRefnetId: string;
  koterRefnetName: string;
  createdAt: string;
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
  bestMatch: KoterRefnetResult | null;
  confidence: number;
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

// ─── Auto-match (via Koter MCP) ────────────────────────────────────────────

export async function autoMatchProviders(
  providers: Array<{ nome: string; cidade: string; estado: string }>
): Promise<AutoMatchResult[]> {
  const results: AutoMatchResult[] = [];

  for (const p of providers) {
    const existing = getMappingByKey(p.nome, p.cidade);
    if (existing) continue;

    try {
      // Search Koter MCP by provider name, filtered by state
      const { refnets } = await searchKoterLive(p.nome, p.estado, 1, 5);

      if (refnets.length > 0) {
        // Score best match by similarity
        const best = refnets[0]; // MCP already returns ranked by relevance
        const confidence = computeConfidence(p.nome, p.cidade, best);

        results.push({
          amilNome: p.nome,
          amilCidade: p.cidade,
          bestMatch: confidence >= 0.4 ? best : null,
          confidence,
        });
      } else {
        results.push({ amilNome: p.nome, amilCidade: p.cidade, bestMatch: null, confidence: 0 });
      }
    } catch {
      results.push({ amilNome: p.nome, amilCidade: p.cidade, bestMatch: null, confidence: 0 });
    }
  }

  return results;
}

function normalizeName(name: string): string {
  let n = name.toUpperCase().trim();
  n = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const noise = ["HOSPITAL", "HOSP", "CLINICA", "LABORATORIO", "LAB", "CENTRO",
    "INSTITUTO", "S/A", "SA", "LTDA", "ME", "EIRELI", "AMIL", "AMIL -", "AMIL-"];
  for (const w of noise) {
    n = n.replace(new RegExp("\\b" + w.replace(/[/.\\-]/g, "\\.?") + "\\b", "g"), "");
  }
  return n.replace(/\s+/g, " ").trim();
}

function computeConfidence(amilNome: string, amilCidade: string, koterRefnet: KoterRefnetResult): number {
  const na = normalizeName(amilNome);
  const nb = normalizeName(koterRefnet.name);

  let score = 0;
  if (na === nb) score = 1;
  else if (na.includes(nb) || nb.includes(na)) score = 0.85;
  else {
    const tokensA = na.split(/\s+/);
    const tokensB = nb.split(/\s+/);
    const matches = tokensA.filter((t) =>
      tokensB.some((bt) => bt === t || bt.includes(t) || t.includes(bt))
    );
    score = matches.length / Math.max(tokensA.length, tokensB.length);
  }

  // Boost if city matches
  const normCity = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
  if (normCity(amilCidade) === normCity(koterRefnet.cityName || "")) {
    score = Math.min(1, score + 0.15);
  }

  return score;
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
