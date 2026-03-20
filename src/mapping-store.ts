import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const MAPPINGS_FILE = path.join(DATA_DIR, "mappings.json");

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

interface MappingData {
  version: number;
  mappings: RefnetMapping[];
  koterRefnets: KoterRefnet[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeKey(nome: string, cidade: string): string {
  return (nome + "|" + cidade).toUpperCase().trim().replace(/\s+/g, " ");
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadData(): MappingData {
  ensureDataDir();
  if (!fs.existsSync(MAPPINGS_FILE)) {
    return { version: 1, mappings: [], koterRefnets: [] };
  }
  try {
    const raw = fs.readFileSync(MAPPINGS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, mappings: [], koterRefnets: [] };
  }
}

function saveData(data: MappingData): void {
  ensureDataDir();
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ─── Mappings CRUD ──────────────────────────────────────────────────────────

export function getAllMappings(estado?: string): RefnetMapping[] {
  const data = loadData();
  if (estado) {
    return data.mappings.filter(
      (m) => m.amilEstado.toUpperCase() === estado.toUpperCase()
    );
  }
  return data.mappings;
}

export function getMappingByKey(
  nome: string,
  cidade: string
): RefnetMapping | null {
  const key = normalizeKey(nome, cidade);
  const data = loadData();
  return data.mappings.find((m) => normalizeKey(m.amilNome, m.amilCidade) === key) || null;
}

export function upsertMapping(mapping: RefnetMapping): RefnetMapping {
  const data = loadData();
  const key = normalizeKey(mapping.amilNome, mapping.amilCidade);
  const idx = data.mappings.findIndex(
    (m) => normalizeKey(m.amilNome, m.amilCidade) === key
  );
  if (idx >= 0) {
    data.mappings[idx] = { ...mapping, createdAt: data.mappings[idx].createdAt };
  } else {
    data.mappings.push({ ...mapping, createdAt: new Date().toISOString() });
  }
  saveData(data);
  return mapping;
}

export function deleteMapping(nome: string, cidade: string): boolean {
  const key = normalizeKey(nome, cidade);
  const data = loadData();
  const before = data.mappings.length;
  data.mappings = data.mappings.filter(
    (m) => normalizeKey(m.amilNome, m.amilCidade) !== key
  );
  if (data.mappings.length < before) {
    saveData(data);
    return true;
  }
  return false;
}

export function bulkLookupMappings(
  providers: Array<{ nome: string; cidade: string }>
): Map<string, RefnetMapping> {
  const data = loadData();
  const result = new Map<string, RefnetMapping>();
  for (const p of providers) {
    const key = normalizeKey(p.nome, p.cidade);
    const found = data.mappings.find(
      (m) => normalizeKey(m.amilNome, m.amilCidade) === key
    );
    if (found) result.set(key, found);
  }
  return result;
}

// ─── Koter Refnets Cache ───────────────────────────────────────────────────

export function getKoterRefnets(stateName?: string): KoterRefnet[] {
  const data = loadData();
  if (stateName) {
    return data.koterRefnets.filter(
      (r) => r.stateName.toUpperCase() === stateName.toUpperCase()
    );
  }
  return data.koterRefnets;
}

export function searchKoterRefnets(
  query: string,
  stateName?: string,
  cityName?: string,
  limit = 20
): KoterRefnet[] {
  const data = loadData();
  const q = query.toUpperCase().trim().replace(/\s+/g, " ");
  if (!q) return [];

  let candidates = data.koterRefnets;
  if (stateName) {
    candidates = candidates.filter(
      (r) => r.stateName.toUpperCase() === stateName.toUpperCase()
    );
  }
  if (cityName) {
    candidates = candidates.filter(
      (r) => r.cityName.toUpperCase() === cityName.toUpperCase()
    );
  }

  // Score each candidate
  const scored = candidates.map((r) => {
    const name = r.name.toUpperCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q)) score = 80;
    else if (q.includes(name)) score = 70;
    else {
      // Token-based matching
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
  const data = loadData();
  const existingIds = new Set(data.koterRefnets.map((r) => r.id));
  let added = 0;
  for (const r of refnets) {
    if (!existingIds.has(r.id)) {
      data.koterRefnets.push(r);
      existingIds.add(r.id);
      added++;
    } else {
      // Update existing
      const idx = data.koterRefnets.findIndex((x) => x.id === r.id);
      if (idx >= 0) data.koterRefnets[idx] = r;
    }
  }
  saveData(data);
  return added;
}

export function getKoterRefnetStats(): {
  total: number;
  byState: Record<string, number>;
} {
  const data = loadData();
  const byState: Record<string, number> = {};
  for (const r of data.koterRefnets) {
    byState[r.stateName] = (byState[r.stateName] || 0) + 1;
  }
  return { total: data.koterRefnets.length, byState };
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
  // Remove accents
  n = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Remove noise words
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

export interface AutoMatchResult {
  amilNome: string;
  amilCidade: string;
  bestMatch: KoterRefnet | null;
  confidence: number;
  alternatives: Array<{ refnet: KoterRefnet; confidence: number }>;
}

export function autoMatchProviders(
  providers: Array<{ nome: string; cidade: string; estado: string }>,
  threshold = 0.5
): AutoMatchResult[] {
  const data = loadData();
  const results: AutoMatchResult[] = [];

  for (const p of providers) {
    // Skip already mapped
    const existing = getMappingByKey(p.nome, p.cidade);
    if (existing) continue;

    // Filter Koter refnets by state (fuzzy)
    const stateRefnets = data.koterRefnets.filter((r) => {
      const rState = r.stateName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const pState = (p.estado || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return rState.includes(pState) || pState.includes(rState) || rState === pState;
    });

    // Score all candidates
    const scored = stateRefnets.map((r) => {
      let conf = similarity(p.nome, r.name);
      // Boost if city matches
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

// ─── Export for Koter import ────────────────────────────────────────────────

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
