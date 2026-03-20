import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function getKoterMcpUrl(): string {
  const url = process.env.KOTER_MCP_URL;
  if (!url) throw new Error("KOTER_MCP_URL environment variable is required");
  return url;
}

let client: Client | null = null;

// State name -> Koter stateId mapping (cached on first fetch)
let statesCache: Array<{ id: string; name: string; abbreviation: string }> | null = null;

function resetClient(): void {
  try { client?.close(); } catch {}
  client = null;
}

async function getClient(): Promise<Client> {
  if (client) return client;

  const c = new Client({ name: "amil-mcp-koter-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(getKoterMcpUrl()));
  await c.connect(transport);
  client = c;
  return client;
}

export async function callKoterTool(name: string, args: Record<string, any>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = await getClient();
      return await c.callTool({ name, arguments: args });
    } catch (err: any) {
      console.error(`[Koter MCP] Tool ${name} failed (attempt ${attempt + 1}):`, err.message);
      resetClient();
      if (attempt === 1) throw err;
    }
  }
}

async function getStates(): Promise<Array<{ id: string; name: string; abbreviation: string }>> {
  if (statesCache) return statesCache;

  const result = await callKoterTool("fetch_all_states", {});
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

// Map Amil region names to actual state names
const AMIL_STATE_ALIASES: Record<string, string> = {
  "SP E INTERIOR": "São Paulo",
  "RJ E ES": "Rio de Janeiro",
  "INTERIOR SP - 1": "São Paulo",
  "INTERIOR SP - 2": "São Paulo",
};

export async function resolveStateId(stateName: string): Promise<string | null> {
  const states = await getStates();
  // Check alias first
  const aliased = AMIL_STATE_ALIASES[stateName.toUpperCase().trim()];
  const norm = normalizeForMatch(aliased || stateName);

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
  const args: Record<string, any> = { name: query, page, pageSize };
  if (stateName) {
    const stateId = await resolveStateId(stateName);
    if (stateId) args.stateId = stateId;
  }

  const result = await callKoterTool("fetch_referenced_networks_cadastro", args);
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

export async function createKoterRefnet(
  name: string,
  cityId: string,
  userId = "d2i4sdzg8nh7vy2egv4rjers"
): Promise<{ id: string; name: string }> {
  const result = await callKoterTool("create_referenced_network", { userId, name, cityId });
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse create_referenced_network response");
  const data = JSON.parse(jsonMatch[0]);
  return { id: data.id || data.refnet?.id, name: data.name || data.refnet?.name || name };
}
