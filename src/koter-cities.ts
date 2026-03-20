import { callKoterTool, resolveStateId } from "./koter-client.js";

export interface KoterCity {
  id: string;
  name: string;
  stateId: string;
  stateName: string;
}

// Cache cities by stateId
const citiesCache = new Map<string, { cities: KoterCity[]; at: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1h

const UF_TO_NAME: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas",
  BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo",
  GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina",
  SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};

// Amil uses region names that map to actual states
const AMIL_STATE_ALIASES: Record<string, string> = {
  "SP E INTERIOR": "São Paulo",
  "RJ E ES": "Rio de Janeiro",
  "INTERIOR SP - 1": "São Paulo",
  "INTERIOR SP - 2": "São Paulo",
  "SÃO PAULO": "São Paulo",
  "RIO DE JANEIRO": "Rio de Janeiro",
  "BAHIA": "Bahia",
  "CEARÁ": "Ceará",
  "DISTRITO FEDERAL": "Distrito Federal",
  "GOIÁS": "Goiás",
  "MARANHÃO": "Maranhão",
  "MINAS GERAIS": "Minas Gerais",
  "PARAÍBA": "Paraíba",
  "PARANÁ": "Paraná",
  "PERNAMBUCO": "Pernambuco",
  "RIO GRANDE DO NORTE": "Rio Grande do Norte",
  "RIO GRANDE DO SUL": "Rio Grande do Sul",
  "SANTA CATARINA": "Santa Catarina",
};

// Map "REGIÃO METROPOLITANA" and similar generic city names to the state capital
const STATE_CAPITAL: Record<string, string> = {
  "São Paulo": "São Paulo",
  "Rio de Janeiro": "Rio de Janeiro",
  "Bahia": "Salvador",
  "Ceará": "Fortaleza",
  "Distrito Federal": "Brasília",
  "Goiás": "Goiânia",
  "Maranhão": "São Luís",
  "Minas Gerais": "Belo Horizonte",
  "Paraíba": "João Pessoa",
  "Paraná": "Curitiba",
  "Pernambuco": "Recife",
  "Rio Grande do Norte": "Natal",
  "Rio Grande do Sul": "Porto Alegre",
  "Santa Catarina": "Florianópolis",
  "Espírito Santo": "Vitória",
};

// City names that are actually region descriptors, not real cities
const GENERIC_CITY_NAMES = [
  "REGIÃO METROPOLITANA",
  "REGIAO METROPOLITANA",
  "GRANDE",
  "METROPOLITANA",
];

/**
 * Normalize a generic Amil city name to a real city.
 * "REGIÃO METROPOLITANA" → state capital, "GRANDE SÃO PAULO" → "São Paulo", etc.
 */
function resolveGenericCityName(cityName: string, stateName: string): string | null {
  const upper = cityName.toUpperCase().trim();

  // Exact match for generic names
  if (GENERIC_CITY_NAMES.some(g => upper === g || upper.startsWith(g))) {
    return STATE_CAPITAL[stateName] || null;
  }

  // "GRANDE SÃO PAULO" → "São Paulo", "GRANDE RIO" → "Rio de Janeiro"
  if (upper.startsWith("GRANDE ")) {
    const rest = upper.replace("GRANDE ", "").trim();
    for (const [state, capital] of Object.entries(STATE_CAPITAL)) {
      const normCapital = capital.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
      if (normCapital.includes(rest) || rest.includes(normCapital.split(" ")[0])) {
        return capital;
      }
    }
    return STATE_CAPITAL[stateName] || null;
  }

  return null;
}

export async function getKoterCitiesByState(estadoQuery: string): Promise<KoterCity[]> {
  const upper = estadoQuery.toUpperCase().trim();
  const stateName = AMIL_STATE_ALIASES[upper] || UF_TO_NAME[upper] || estadoQuery;

  const stateId = await resolveStateId(stateName);
  if (!stateId) throw new Error(`State not found in Koter: ${estadoQuery}`);

  const cached = citiesCache.get(stateId);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.cities;

  console.log(`[KoterCities] Fetching cities for ${stateName} (${stateId})...`);
  const result = await callKoterTool("fetch_cities_by_state_name", { stateName });

  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("[KoterCities] Could not parse cities response:", text.substring(0, 500));
    return [];
  }

  const rawCities = JSON.parse(jsonMatch[0]);
  const cities: KoterCity[] = rawCities.map((c: any) => ({
    id: c.id,
    name: c.name,
    stateId: c.stateId || stateId,
    stateName: stateName,
  }));

  citiesCache.set(stateId, { cities, at: Date.now() });
  console.log(`[KoterCities] Cached ${cities.length} cities for ${stateName}`);
  return cities;
}

/**
 * Resolve an Amil city name to a Koter city (with ID) for a given state.
 * Uses NFD normalization for accent-insensitive matching.
 */
export async function resolveKoterCityId(
  amilCityName: string,
  estadoQuery: string
): Promise<KoterCity | null> {
  const normCity = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
  try {
    const cities = await getKoterCitiesByState(estadoQuery);
    const norm = normCity(amilCityName);

    // 1. Direct match
    const direct = cities.find((c) => normCity(c.name) === norm);
    if (direct) return direct;

    // 2. Resolve generic city names (REGIÃO METROPOLITANA → capital)
    const upper = estadoQuery.toUpperCase().trim();
    const stateName = AMIL_STATE_ALIASES[upper] || UF_TO_NAME[upper] || estadoQuery;
    const resolved = resolveGenericCityName(amilCityName, stateName);
    if (resolved) {
      const resolvedMatch = cities.find((c) => normCity(c.name) === normCity(resolved));
      if (resolvedMatch) {
        console.log(`[KoterCities] Resolved "${amilCityName}" → "${resolved}" (${stateName})`);
        return resolvedMatch;
      }
    }

    return null;
  } catch {
    return null;
  }
}
