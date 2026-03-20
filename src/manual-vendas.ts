import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf: (buf: Buffer) => Promise<{ numpages: number; text: string }> =
  require("pdf-parse/lib/pdf-parse.js");

const MANUAL_URL =
  "https://kitcorretoramil.com.br/wp-content/themes/kitcorretor/pdfs/Manual_de_Vendas_PME.pdf?updated=02-03-2026";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RegionalProduct {
  produto: string;
  cidades: string[];
}

export interface NationalCities {
  estado: string;
  cidades: string[];
}

export interface ComercializacaoResult {
  regionais: RegionalProduct[];
  nacionais: NationalCities[];
}

// ─── PDF Download + Parse ───────────────────────────────────────────────────

let cachedParsed: ComercializacaoResult | null = null;
let cachedAt = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function downloadAndParse(): Promise<ComercializacaoResult> {
  if (cachedParsed && Date.now() - cachedAt < CACHE_TTL) return cachedParsed;

  console.log("[ManualVendas] Downloading PDF...");
  const res = await fetch(MANUAL_URL);
  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  console.log("[ManualVendas] Parsing PDF...");
  const data = await pdf(buf);
  const text = data.text;

  // Find "8.2 Anexo II – Regiões de Comercialização"
  const startMarker = "8.2 Anexo II";
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) throw new Error("Section '8.2 Anexo II' not found in PDF");

  // End at next "8.3 Anexo III"
  const endMarker = "8.3 Anexo III";
  const endIdx = text.indexOf(endMarker, startIdx);
  const section = endIdx === -1 ? text.substring(startIdx) : text.substring(startIdx, endIdx);

  const result = parseComercializacao(section);
  cachedParsed = result;
  cachedAt = Date.now();
  console.log(
    `[ManualVendas] Parsed ${result.regionais.length} regional products, ${result.nacionais.length} states for national`
  );
  return result;
}

// ─── Parsing Logic ──────────────────────────────────────────────────────────

function cleanText(s: string): string {
  return s
    .replace(/\n\s*\d+\s*\n/g, "\n")             // page numbers
    .replace(/Versão\s+\d{4}\.\d{2}/g, "")        // "Versão 2026.03"
    .replace(/\w+\/\d{4}/g, "")                    // "Março/2026"
    .replace(/Març\w*/g, "")                       // stray "Março" or "Març"
    .replace(/\.\s*$/g, "")                         // trailing period
    .replace(/\s+/g, " ")
    .trim();
}

function parseCityList(raw: string): string[] {
  return raw
    .split(",")
    .map((c) =>
      c
        .replace(/\.\s*$/, "")           // trailing period
        .replace(/\s*-\s*/g, "-")         // fix "Biritiba- Mirim" -> "Biritiba-Mirim"
        .replace(/\s+/g, " ")
        .trim()
    )
    .map((c) => c.replace(/\.\s*Març.*$/, "").replace(/\.\s*$/, "").trim()) // strip trailing ". Março..." from last city
    .filter((c) => c.length > 2 && !c.match(/^\d+$/) && !c.match(/^Março|^Versão|^Anexo/i));
}

function parseComercializacao(section: string): ComercializacaoResult {
  const regionais: RegionalProduct[] = [];
  const nacionais: NationalCities[] = [];

  // Split into regional and national parts
  const nationalIdx = section.indexOf("Produtos Nacionais");
  const regionalPart = nationalIdx !== -1 ? section.substring(0, nationalIdx) : section;
  const nationalPart = nationalIdx !== -1 ? section.substring(nationalIdx) : "";

  // ─── Parse Regional Products ────────────────────────────────────────────
  // Pattern: "Amil Bronze SP: comercializado em X municípios: city1, city2, ..."
  // or "Amil Bronze SP: comercializado em X cidades: city1, city2, ..."
  const regionalRegex =
    /(Amil\s+[^:]+?):\s*comercializado\s+em\s+\d+\s+(?:municípios|cidades):\s*([\s\S]*?)(?=(?:Amil\s+\w+[^:]*?:\s*comercializado)|Produtos Nacionais|$)/gi;
  let match;
  while ((match = regionalRegex.exec(regionalPart)) !== null) {
    const produto = match[1].replace(/\s+/g, " ").trim();
    const citiesRaw = cleanText(match[2]);
    const cidades = parseCityList(citiesRaw);
    if (cidades.length > 0) {
      regionais.push({ produto, cidades });
    }
  }

  // ─── Parse National Products (by state) ─────────────────────────────────
  // Pattern: "BA: city1, city2, ...\nCE: city1, city2, ..."
  const stateRegex =
    /\b([A-Z]{2}):\s*([\s\S]*?)(?=\b[A-Z]{2}:\s|8\.3 Anexo|$)/g;
  while ((match = stateRegex.exec(nationalPart)) !== null) {
    const estado = match[1];
    // Skip non-state abbreviations
    if (["De", "Do", "Da"].includes(estado)) continue;
    const citiesRaw = cleanText(match[2]);
    const cidades = parseCityList(citiesRaw);
    if (cidades.length > 0) {
      nacionais.push({ estado, cidades });
    }
  }

  return { regionais, nacionais };
}

// ─── City Name Matching (inspired by Koter's Python matcher) ────────────────

const APOSTROPHES = ["'", "\u2018", "\u2019", "\u02BC", "`", "\u00B4"];
const HYPHENS = ["-", "\u2013", "\u2014", "\u2212", "\u2010", "\uFF0D", "\u2012"];
const ARTICLES = new Set(["da", "de", "do", "das", "dos", "d"]);

function stripAccents(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function unifyPunctuation(s: string): string {
  s = s.replace(/\./g, " ");
  for (const a of APOSTROPHES) s = s.replaceAll(a, "'");
  for (const h of HYPHENS) s = s.replaceAll(h, "-");
  s = s.replace(/\bd\s+'/gi, "d'");
  return collapseWs(s);
}

function baseKey(s: string): string {
  s = unifyPunctuation(s);
  s = s.replace(/-/g, " ").replace(/'/g, " ");
  s = stripAccents(s.toLowerCase());
  s = s.replace(/[^a-z0-9\s]/g, " ");
  return collapseWs(s);
}

function withoutArticles(s: string): string {
  const tokens = baseKey(s).split(" ").filter((t) => !ARTICLES.has(t));
  return collapseWs(tokens.join(" "));
}

function expandDApostrophe(s: string): string {
  s = unifyPunctuation(s);
  s = s.replace(/\bd'/gi, "de ");
  return baseKey(s);
}

function makeAliases(cityName: string): string[] {
  const aliases = new Set<string>();
  aliases.add(baseKey(cityName));
  aliases.add(expandDApostrophe(cityName));
  aliases.add(withoutArticles(cityName));
  const expanded = unifyPunctuation(cityName).replace(/\bd'/gi, "de ");
  aliases.add(withoutArticles(expanded));
  aliases.add(baseKey(cityName.replace(/,/g, " ")));
  aliases.delete("");
  return [...aliases];
}

function buildCityIndex(
  koterCities: Array<{ id: string; name: string }>
): Map<string, string> {
  const index = new Map<string, string>(); // alias -> koterCityId
  for (const c of koterCities) {
    for (const alias of makeAliases(c.name)) {
      if (!index.has(alias)) index.set(alias, c.id);
    }
  }
  return index;
}

function matchCity(
  cityName: string,
  index: Map<string, string>
): string | null {
  const keysToTry = [
    baseKey(cityName),
    expandDApostrophe(cityName),
    withoutArticles(cityName),
  ];
  for (const k of keysToTry) {
    if (k && index.has(k)) return index.get(k)!;
  }
  return null;
}

// ─── State abbreviation to full name mapping ─────────────────────────────────

const UF_TO_NAME: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas",
  BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo",
  GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina",
  SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};

// Regional product names contain state abbreviations
function getRegionalStateAbbr(productName: string): string | null {
  // "Amil Bronze SP" -> "SP", "Amil Bronze RJ Mais" -> "RJ", "Amil Bronze DF" -> "DF", "Amil Bronze PR" -> "PR"
  const m = productName.match(/\b(SP|RJ|DF|PR|MG|BA|CE|RS|SC|GO|PE)\b/);
  return m ? m[1] : null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CityWithId {
  nome: string;
  koterCityId: string | null;
}

export interface ProductComercializacao {
  produto: string;
  cidades: CityWithId[];
}

export interface EstadoComercializacao {
  produtos_regionais: ProductComercializacao[];
  produtos_nacionais: CityWithId[];
}

export async function getComercializacaoByState(
  estadoQuery: string,
  koterCities: Array<{ id: string; name: string; stateId: string; stateName: string }>
): Promise<EstadoComercializacao> {
  const parsed = await downloadAndParse();
  const normQuery = baseKey(estadoQuery);

  // Find which UF matches the query
  let uf: string | null = null;
  for (const [abbr, name] of Object.entries(UF_TO_NAME)) {
    if (baseKey(abbr) === normQuery || baseKey(name) === normQuery) {
      uf = abbr;
      break;
    }
  }
  if (!uf) {
    for (const [abbr, name] of Object.entries(UF_TO_NAME)) {
      if (baseKey(name).includes(normQuery) || normQuery.includes(baseKey(name))) {
        uf = abbr;
        break;
      }
    }
  }
  if (!uf) throw new Error(`Estado não encontrado: ${estadoQuery}`);

  // Build city index using robust alias matching
  const cityIndex = buildCityIndex(koterCities);

  function resolveCities(cityNames: string[]): CityWithId[] {
    return cityNames.map((nome) => ({
      nome,
      koterCityId: matchCity(nome, cityIndex),
    }));
  }

  // Find regional products for this state
  const produtos_regionais: ProductComercializacao[] = [];
  for (const rp of parsed.regionais) {
    const rpUf = getRegionalStateAbbr(rp.produto);
    if (rpUf === uf) {
      produtos_regionais.push({
        produto: rp.produto,
        cidades: resolveCities(rp.cidades),
      });
    }
  }

  // Find national cities for this state
  let produtos_nacionais: CityWithId[] = [];
  const natEntry = parsed.nacionais.find((n) => n.estado === uf);
  if (natEntry) {
    produtos_nacionais = resolveCities(natEntry.cidades);
  }

  return { produtos_regionais, produtos_nacionais };
}

export { downloadAndParse };
