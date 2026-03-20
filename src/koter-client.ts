import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const KOTER_MCP_URL =
  process.env.KOTER_MCP_URL ||
  "https://api.koter.app/mcp/networks/legacy?apiKey=MhuVw8HA/Zf2FrGV01Qho5UeIei73k4qpyjhBjASU/hlLrzeJmCs5hvN0P9A3pLxKDo/HeRGWk7boKfy3vPjJA==";

let client: Client | null = null;

// State name -> Koter stateId mapping (cached on first fetch)
let statesCache: Array<{ id: string; name: string; abbreviation: string }> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;

  client = new Client({ name: "amil-mcp-koter-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(KOTER_MCP_URL));
  await client.connect(transport);
  return client;
}

async function getStates(): Promise<Array<{ id: string; name: string; abbreviation: string }>> {
  if (statesCache) return statesCache;

  const c = await getClient();
  const result = await c.callTool({ name: "fetch_all_states", arguments: {} });
  // Parse the text content to extract states
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Extract JSON array from the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse states from Koter MCP");
  statesCache = JSON.parse(jsonMatch[0]);
  return statesCache!;
}

function normalizeForMatch(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

export async function resolveStateId(stateName: string): Promise<string | null> {
  const states = await getStates();
  const norm = normalizeForMatch(stateName);
  const found = states.find((s) => normalizeForMatch(s.name) === norm);
  if (found) return found.id;
  // Try partial match
  const partial = states.find(
    (s) => normalizeForMatch(s.name).includes(norm) || norm.includes(normalizeForMatch(s.name))
  );
  return partial?.id || null;
}

export interface KoterRefnetResult {
  id: string;
  name: string;
  cityId: string;
  cityName: string;
  stateName: string;
  cnes?: string;
}

export async function searchKoterRefnets(
  query: string,
  stateName?: string,
  page = 1,
  pageSize = 20
): Promise<{ refnets: KoterRefnetResult[]; total: number }> {
  const c = await getClient();

  const args: Record<string, any> = { name: query, page, pageSize };
  if (stateName) {
    const stateId = await resolveStateId(stateName);
    if (stateId) args.stateId = stateId;
  }

  const result = await c.callTool({ name: "fetch_referenced_networks_cadastro", arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { refnets: [], total: 0 };

  const data = JSON.parse(jsonMatch[0]);
  const refnets: KoterRefnetResult[] = (data.refnets || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    cityId: r.cityId,
    cityName: r.cityName,
    stateName: stateName || "",
    cnes: r.cnes,
  }));

  return { refnets, total: data.total || refnets.length };
}

export async function getKoterStates(): Promise<Array<{ id: string; name: string; abbreviation: string }>> {
  return getStates();
}
