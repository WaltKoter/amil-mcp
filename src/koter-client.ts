import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const FALLBACK_KOTER_MCP_URL = "https://api.koter.app/mcp/networks/legacy?apiKey=MhuVw8HA/Zf2FrGV01Qho5UeIei73k4qpyjhBjASU/hlLrzeJmCs5hvN0P9A3pLxKDo/HeRGWk7boKfy3vPjJA==";

function getKoterMcpUrl(): string {
  const url = process.env.KOTER_MCP_URL || FALLBACK_KOTER_MCP_URL;
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
  pageSize = 20,
  cityId?: string
): Promise<{ refnets: KoterRefnetResult[]; total: number }> {
  const args: Record<string, any> = { name: query, page, pageSize };
  if (cityId) {
    args.cityId = cityId;
  } else if (stateName) {
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
  cityName?: string,
  userId = process.env.KOTER_USER_ID || "d2i4sdzg8nh7vy2egv4rjers"
): Promise<{ id: string; name: string }> {
  // Try with original name first, if duplicate error, retry with " - CityName"
  const namesToTry = [name];
  if (cityName) {
    namesToTry.push(`${name} - ${cityName}`);
  }

  let lastError = "";
  for (const tryName of namesToTry) {
    const result = await callKoterTool("create_referenced_network", { userId, name: tryName, cityId });
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    console.log("[Koter Create] Trying name:", tryName, "| Response:", text.substring(0, 300));

    // Check for duplicate error
    if (text.toLowerCase().includes("duplici") || text.toLowerCase().includes("já existir") || text.toLowerCase().includes("ja existir") || text.includes("approximate_name")) {
      lastError = text.substring(0, 200);
      console.log("[Koter Create] Duplicate detected, will retry with city suffix");
      continue;
    }

    // Try to parse success response
    const parsed = parseCreateResponse(text, tryName);
    if (parsed) return parsed;

    lastError = text.substring(0, 200);
  }

  throw new Error("Could not create refnet: " + lastError);
}

function parseCreateResponse(text: string, name: string): { id: string; name: string } | null {
  // 1. Try to find a JSON object with an "id" field
  const allJsonMatches = text.match(/\{[^{}]*"id"[^{}]*\}/g);
  if (allJsonMatches) {
    for (const jsonStr of allJsonMatches) {
      try {
        const data = JSON.parse(jsonStr);
        if (data.id) return { id: data.id, name: data.name || name };
      } catch {}
    }
  }

  // 2. Try the largest JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      const id = data.id || data.refnet?.id || data.data?.id;
      if (id) return { id, name: data.name || data.refnet?.name || data.data?.name || name };
    } catch {}
  }

  // 3. Try to extract ID from text patterns
  const idMatch = text.match(/["']?id["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]{10,})["']?/i);
  if (idMatch) {
    return { id: idMatch[1], name };
  }

  return null;
}
