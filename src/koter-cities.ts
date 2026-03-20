import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveStateId } from "./koter-client.js";

const KOTER_MCP_URL =
  process.env.KOTER_MCP_URL ||
  "https://api.koter.app/mcp/networks/legacy?apiKey=MhuVw8HA/Zf2FrGV01Qho5UeIei73k4qpyjhBjASU/hlLrzeJmCs5hvN0P9A3pLxKDo/HeRGWk7boKfy3vPjJA==";

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  client = new Client({ name: "amil-mcp-koter-cities", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(KOTER_MCP_URL));
  await client.connect(transport);
  return client;
}

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

export async function getKoterCitiesByState(estadoQuery: string): Promise<KoterCity[]> {
  // Resolve UF abbreviation to full state name
  const upper = estadoQuery.toUpperCase().trim();
  const stateName = UF_TO_NAME[upper] || estadoQuery;

  const stateId = await resolveStateId(stateName);
  if (!stateId) throw new Error(`State not found in Koter: ${estadoQuery}`);

  // Check cache
  const cached = citiesCache.get(stateId);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.cities;

  console.log(`[KoterCities] Fetching cities for ${stateName} (${stateId})...`);
  const c = await getClient();
  const result = await c.callTool({
    name: "fetch_cities_by_state_name",
    arguments: { stateName },
  });

  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Parse JSON array from response
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
