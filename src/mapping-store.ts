import { query } from "./db.js";
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

// ─── All Providers (full Amil network) ──────────────────────────────────────

export interface AllProvider {
  nome: string;
  cidade: string;
  estado: string;
  tipoRede: string;
  linhas: string[];
  categorias: string[];
  modalidades: string;
}

export interface AllProviderWithMapping extends AllProvider {
  koterRefnetId: string | null;
  koterRefnetName: string | null;
}

export async function upsertAllProviders(providers: AllProvider[]): Promise<void> {
  for (const p of providers) {
    const existing = await query(
      `SELECT linhas, categorias FROM all_providers WHERE nome = $1 AND cidade = $2 AND tipo_rede = $3`,
      [p.nome, p.cidade, p.tipoRede]
    );

    let linhas = p.linhas;
    let categorias = p.categorias;
    if (existing.rows.length > 0) {
      const el = JSON.parse(existing.rows[0].linhas || "[]");
      const ec = JSON.parse(existing.rows[0].categorias || "[]");
      linhas = [...new Set([...el, ...linhas])];
      categorias = [...new Set([...ec, ...categorias])];
    }

    await query(
      `INSERT INTO all_providers (nome, cidade, estado, tipo_rede, linhas, categorias, modalidades)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (nome, cidade, tipo_rede) DO UPDATE SET
         estado = EXCLUDED.estado, linhas = EXCLUDED.linhas,
         categorias = EXCLUDED.categorias, modalidades = EXCLUDED.modalidades,
         fetched_at = NOW()`,
      [p.nome, p.cidade, p.estado, p.tipoRede, JSON.stringify(linhas), JSON.stringify(categorias), p.modalidades]
    );
  }
}

export async function getAllStoredProviders(filters: {
  estado?: string;
  tipoRede?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ providers: AllProviderWithMapping[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.estado) {
    conditions.push(`p.estado = $${idx++}`);
    params.push(filters.estado);
  }
  if (filters.tipoRede) {
    conditions.push(`p.tipo_rede = $${idx++}`);
    params.push(filters.tipoRede);
  }
  if (filters.search) {
    conditions.push(`(p.nome ILIKE $${idx} OR p.cidade ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }
  if (filters.status === "mapped") {
    conditions.push(`m.koter_refnet_id IS NOT NULL`);
  } else if (filters.status === "pending") {
    conditions.push(`m.koter_refnet_id IS NULL`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const offset = (page - 1) * pageSize;

  const countResult = await query(
    `SELECT COUNT(*) as cnt FROM all_providers p
     LEFT JOIN mappings m ON p.nome = m.amil_nome AND p.cidade = m.amil_cidade
     ${where}`,
    params
  );

  const dataResult = await query(
    `SELECT p.nome, p.cidade, p.estado, p.tipo_rede as "tipoRede", p.linhas, p.categorias, p.modalidades,
            m.koter_refnet_id as "koterRefnetId", m.koter_refnet_name as "koterRefnetName"
     FROM all_providers p
     LEFT JOIN mappings m ON p.nome = m.amil_nome AND p.cidade = m.amil_cidade
     ${where}
     ORDER BY p.estado, p.cidade, p.nome
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, pageSize, offset]
  );

  return {
    providers: dataResult.rows.map((r: any) => ({
      nome: r.nome,
      cidade: r.cidade,
      estado: r.estado,
      tipoRede: r.tipoRede,
      linhas: JSON.parse(r.linhas || "[]"),
      categorias: JSON.parse(r.categorias || "[]"),
      modalidades: r.modalidades || "",
      koterRefnetId: r.koterRefnetId || null,
      koterRefnetName: r.koterRefnetName || null,
    })),
    total: parseInt(countResult.rows[0].cnt),
  };
}

export async function getProviderStates(): Promise<string[]> {
  const result = await query(`SELECT DISTINCT estado FROM all_providers ORDER BY estado`);
  return result.rows.map((r: any) => r.estado);
}

export async function getProviderStats(filters?: { estado?: string; tipoRede?: string }): Promise<{
  total: number;
  mapped: number;
  pending: number;
}> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (filters?.estado) { conditions.push(`p.estado = $${idx++}`); params.push(filters.estado); }
  if (filters?.tipoRede) { conditions.push(`p.tipo_rede = $${idx++}`); params.push(filters.tipoRede); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalR = await query(`SELECT COUNT(*) as cnt FROM all_providers p ${where}`, params);
  const mappedR = await query(
    `SELECT COUNT(*) as cnt FROM all_providers p
     INNER JOIN mappings m ON p.nome = m.amil_nome AND p.cidade = m.amil_cidade
     ${where}`,
    params
  );
  const total = parseInt(totalR.rows[0].cnt);
  const mapped = parseInt(mappedR.rows[0].cnt);
  return { total, mapped, pending: total - mapped };
}

export async function getRefnetIdsByCategoria(
  categoria: string,
  estado?: string,
  planName?: string,
  tipoRede = "Hospitais"
): Promise<string[]> {
  // Build estado filter - match providers from this state only
  // Handle aliases: "INTERIOR SP - 1" should match all SP providers, etc.
  let estadoPattern = "";
  if (estado) {
    const up = estado.toUpperCase();
    if (up.includes("SP") || up.includes("PAULO")) estadoPattern = "%SP%";
    else if (up.includes("RJ") || up.includes("JANEIRO")) estadoPattern = "%RJ%";
    else if (up.includes("ES") || up.includes("ESPÍRITO") || up.includes("ESPIRITO")) estadoPattern = "%ES%";
    else estadoPattern = `%${up}%`;
  }
  const estadoFilter = estado ? `AND UPPER(p.estado) ILIKE $3` : "";
  const baseParams = (catPattern: string) =>
    estado ? [catPattern, tipoRede, estadoPattern] : [catPattern, tipoRede];

  // 1. Exact category match (case-insensitive), filtered by state
  let result = await query(
    `SELECT DISTINCT m.koter_refnet_id
     FROM all_providers p
     INNER JOIN mappings m ON p.nome = m.amil_nome AND p.cidade = m.amil_cidade
     WHERE LOWER(p.categorias) ILIKE $1 AND p.tipo_rede = $2 ${estadoFilter}`,
    baseParams(`%${categoria.toLowerCase()}%`)
  );

  if (result.rows.length > 0) {
    return result.rows.map((r: any) => r.koter_refnet_id);
  }

  // 2. Try with plan name keywords
  if (planName) {
    const keywords = planName.toUpperCase()
      .replace(/^AMIL\s+/i, "")
      .replace(/\s+(QC|QP|R|N|COPART|COPARTICIPACAO)\b/gi, "")
      .trim();
    if (keywords && keywords !== categoria.toUpperCase()) {
      result = await query(
        `SELECT DISTINCT m.koter_refnet_id
         FROM all_providers p
         INNER JOIN mappings m ON p.nome = m.amil_nome AND p.cidade = m.amil_cidade
         WHERE LOWER(p.categorias) ILIKE $1 AND p.tipo_rede = $2 ${estadoFilter}`,
        baseParams(`%${keywords.toLowerCase()}%`)
      );
      if (result.rows.length > 0) {
        return result.rows.map((r: any) => r.koter_refnet_id);
      }
    }
  }

  // 3. Try individual words from categoria
  const words = categoria.split(/\s+/).filter(w => w.length >= 3);
  for (const word of words) {
    result = await query(
      `SELECT DISTINCT m.koter_refnet_id
       FROM all_providers p
       INNER JOIN mappings m ON p.nome = m.amil_nome AND p.cidade = m.amil_cidade
       WHERE LOWER(p.categorias) ILIKE $1 AND p.tipo_rede = $2 ${estadoFilter}`,
      baseParams(`%${word.toLowerCase()}%`)
    );
    if (result.rows.length > 0) {
      return result.rows.map((r: any) => r.koter_refnet_id);
    }
  }

  return [];
}

export async function clearAllProviders(tipoRede?: string): Promise<void> {
  if (tipoRede) {
    await query(`DELETE FROM all_providers WHERE tipo_rede = $1`, [tipoRede]);
  } else {
    await query(`DELETE FROM all_providers`);
  }
}

// ─── Mappings CRUD ──────────────────────────────────────────────────────────

export async function getAllMappings(estado?: string): Promise<RefnetMapping[]> {
  if (estado) {
    const result = await query(
      `SELECT amil_nome as "amilNome", amil_cidade as "amilCidade", amil_estado as "amilEstado",
              koter_refnet_id as "koterRefnetId", koter_refnet_name as "koterRefnetName", created_at as "createdAt"
       FROM mappings WHERE UPPER(amil_estado) = UPPER($1)`,
      [estado]
    );
    return result.rows;
  }
  const result = await query(
    `SELECT amil_nome as "amilNome", amil_cidade as "amilCidade", amil_estado as "amilEstado",
            koter_refnet_id as "koterRefnetId", koter_refnet_name as "koterRefnetName", created_at as "createdAt"
     FROM mappings`
  );
  return result.rows;
}

export async function getMappingByKey(nome: string, cidade: string): Promise<RefnetMapping | null> {
  const result = await query(
    `SELECT amil_nome as "amilNome", amil_cidade as "amilCidade", amil_estado as "amilEstado",
            koter_refnet_id as "koterRefnetId", koter_refnet_name as "koterRefnetName", created_at as "createdAt"
     FROM mappings WHERE amil_nome = $1 AND amil_cidade = $2`,
    [nome, cidade]
  );
  return result.rows[0] || null;
}

export async function upsertMapping(mapping: RefnetMapping): Promise<RefnetMapping> {
  await query(
    `INSERT INTO mappings (amil_nome, amil_cidade, amil_estado, koter_refnet_id, koter_refnet_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (amil_nome, amil_cidade) DO UPDATE SET
       amil_estado = EXCLUDED.amil_estado,
       koter_refnet_id = EXCLUDED.koter_refnet_id,
       koter_refnet_name = EXCLUDED.koter_refnet_name`,
    [mapping.amilNome, mapping.amilCidade, mapping.amilEstado, mapping.koterRefnetId, mapping.koterRefnetName]
  );
  return mapping;
}

export async function deleteMapping(nome: string, cidade: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM mappings WHERE amil_nome = $1 AND amil_cidade = $2`,
    [nome, cidade]
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Last Network Results ───────────────────────────────────────────────────

export async function saveNetworkResults(
  providers: NetworkProvider[],
  searchParams: Record<string, string>
): Promise<void> {
  const paramsJson = JSON.stringify(searchParams);
  await query(`DELETE FROM last_network_results`);
  for (const p of providers) {
    await query(
      `INSERT INTO last_network_results (nome, cidade, estado, categorias, search_params)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.nome, p.cidade, p.estado, JSON.stringify(p.categorias), paramsJson]
    );
  }
}

export async function getLastNetworkResults(): Promise<{
  providers: NetworkProvider[];
  searchParams: Record<string, string> | null;
}> {
  const result = await query(
    `SELECT nome, cidade, estado, categorias, search_params FROM last_network_results ORDER BY id`
  );

  if (!result.rows.length) return { providers: [], searchParams: null };

  const providers = result.rows.map((r: any) => ({
    nome: r.nome,
    cidade: r.cidade,
    estado: r.estado,
    categorias: JSON.parse(r.categorias || "[]"),
  }));

  let searchParams = null;
  try {
    searchParams = JSON.parse(result.rows[0].search_params);
  } catch {}

  return { providers, searchParams };
}

// ─── Auto-match (via Koter MCP) ────────────────────────────────────────────

export async function autoMatchProviders(
  providers: Array<{ nome: string; cidade: string; estado: string }>
): Promise<AutoMatchResult[]> {
  const results: AutoMatchResult[] = [];

  for (const p of providers) {
    const existing = await getMappingByKey(p.nome, p.cidade);
    if (existing) continue;

    try {
      const { refnets } = await searchKoterLive(p.nome, p.estado, 1, 5);

      if (refnets.length > 0) {
        const best = refnets[0];
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

  const normCity = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
  if (normCity(amilCidade) === normCity(koterRefnet.cityName || "")) {
    score = Math.min(1, score + 0.15);
  }

  return score;
}

// ─── Export for Koter ────────────────────────────────────────────────────────

export interface KoterRefnetExport {
  externalApiProductIds: string[];
  productNames: string[];
  refnetIds: string[];
}

export interface GroupedRefnetExport {
  [categoria: string]: KoterRefnetExport;
}

export async function exportRefnetsForKoter(
  providers: Array<{ nome: string; cidade: string; categorias?: string[]; linhas?: string[] }>,
  productNames?: string[]
): Promise<GroupedRefnetExport> {
  // Group providers by their categorias (Amil product names)
  const groups: Record<string, Set<string>> = {};

  for (const p of providers) {
    const mapping = await getMappingByKey(p.nome, p.cidade);
    if (!mapping) continue;

    const cats = p.categorias && p.categorias.length > 0 ? p.categorias : ["Sem Categoria"];
    for (const cat of cats) {
      if (!groups[cat]) groups[cat] = new Set();
      groups[cat].add(mapping.koterRefnetId);
    }
  }

  // If manual productNames provided, merge all refnets into one group per name
  if (productNames && productNames.length > 0) {
    const allRefnets = new Set<string>();
    for (const set of Object.values(groups)) {
      for (const id of set) allRefnets.add(id);
    }
    const result: GroupedRefnetExport = {};
    for (const name of productNames) {
      result[name] = { externalApiProductIds: [], productNames: [name], refnetIds: [...allRefnets] };
    }
    return result;
  }

  // Auto-grouped by Amil category
  const result: GroupedRefnetExport = {};
  for (const [cat, ids] of Object.entries(groups)) {
    result[cat] = { externalApiProductIds: [], productNames: [cat], refnetIds: [...ids] };
  }
  return result;
}

export interface KoterCityExport {
  externalApiProductIds: string[];
  productNames: string[];
  cityIds: string[];
}

export function exportCitiesForKoter(
  cityIds: string[],
  productNames: string[]
): KoterCityExport {
  return {
    externalApiProductIds: [],
    productNames,
    cityIds: [...new Set(cityIds.filter(Boolean))],
  };
}
