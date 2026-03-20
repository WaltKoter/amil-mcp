import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import {
  getPriceTable,
  getProviders,
  getStates,
  getFormOptions,
  ALL_LINHAS,
} from "./amil-client.js";
import { fetchPriceTablePdf, fetchNetworkPdf } from "./pdf-scraper.js";
import { initDb } from "./db.js";
import {
  getAllMappings,
  upsertMapping,
  deleteMapping,
  autoMatchProviders,
  exportForKoter,
  saveNetworkResults,
  getLastNetworkResults,
} from "./mapping-store.js";
import {
  searchKoterRefnets as searchKoterRefnetsLive,
} from "./koter-client.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  initDb();
  console.log("[DB] SQLite initialized");

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ─── Static files (web UI) ────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ─── Health check ─────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "amil-mcp" });
  });

  // ─── REST API for Web UI ──────────────────────────────────────────────────

  app.get("/api/linhas", (_req, res) => {
    res.json(ALL_LINHAS);
  });

  app.get("/api/form-options", (req, res) => {
    const linha = req.query.linha as string;
    if (!linha) {
      res.status(400).json({ error: "Parâmetro 'linha' é obrigatório" });
      return;
    }
    res.json(getFormOptions(linha));
  });

  app.get("/api/states", async (req, res) => {
    try {
      const { regiao, linha } = req.query as { regiao: string; linha: string };
      if (!regiao || !linha) {
        res.status(400).json({ error: "Parâmetros 'regiao' e 'linha' são obrigatórios" });
        return;
      }
      const states = await getStates({ regiao, linha });
      res.json(states);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/price-table", async (req, res) => {
    try {
      const { estado, numero_vidas, compulsoriedade, coparticipacao, linha } = req.body;
      if (!estado || !numero_vidas || !compulsoriedade || !coparticipacao || !linha) {
        res.status(400).json({ error: "Todos os campos são obrigatórios" });
        return;
      }
      const plans = await getPriceTable({
        estado,
        numero_vidas,
        compulsoriedade,
        coparticipacao,
        linha,
      });
      res.json(plans);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/network", async (req, res) => {
    try {
      const { regiao, estado, linha, tipo_rede } = req.body;
      if (!regiao || !estado || !linha) {
        res.status(400).json({ error: "Parâmetros 'regiao', 'estado' e 'linha' são obrigatórios" });
        return;
      }
      const data = await getProviders({ regiao, estado, linha, tipo_rede });

      // Persist for mapping tab (deduplicated)
      const seen = new Set<string>();
      const flat: Array<{ nome: string; cidade: string; estado: string; categorias: string[] }> = [];
      for (const [cat, items] of Object.entries(data)) {
        if (!Array.isArray(items)) continue;
        for (const item of items as any[]) {
          const key = item.nome + "|" + item.cidade;
          if (!seen.has(key)) {
            seen.add(key);
            const cats: string[] = [];
            for (const [c2, i2] of Object.entries(data)) {
              if (Array.isArray(i2) && (i2 as any[]).some((x: any) => x.nome === item.nome && x.cidade === item.cidade)) cats.push(c2);
            }
            flat.push({ nome: item.nome, cidade: item.cidade, estado: item.estado || estado, categorias: cats });
          }
        }
      }
      saveNetworkResults(flat, { regiao, estado, linha, tipo_rede: tipo_rede || "Hospitais" });

      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/network/last-results", (_req, res) => {
    res.json(getLastNetworkResults());
  });

  // ─── PDF endpoints (Puppeteer scraping from Amil) ────────────────────────

  app.post("/api/pdf/prices", async (req, res) => {
    try {
      const { linha, estado } = req.body;
      if (!linha || !estado) {
        res.status(400).json({ error: "Parâmetros 'linha' e 'estado' são obrigatórios" });
        return;
      }
      console.log(`[PDF] Gerando PDF de preços: ${linha} - ${estado}...`);
      const pdfBuffer = await fetchPriceTablePdf({ linha, estado });
      const filename = `amil-precos-${estado.toLowerCase().replace(/ /g, "-")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      console.error("[PDF] Erro ao gerar PDF de preços:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/pdf/network", async (req, res) => {
    try {
      const { linha, regiao, estado, tipo_rede } = req.body;
      if (!linha || !regiao || !estado) {
        res.status(400).json({ error: "Parâmetros 'linha', 'regiao' e 'estado' são obrigatórios" });
        return;
      }
      console.log(`[PDF] Gerando PDF de rede: ${linha} - ${estado}...`);
      const pdfBuffer = await fetchNetworkPdf({ linha, regiao, estado, tipo_rede });
      const filename = `amil-rede-${estado.toLowerCase().replace(/ /g, "-")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      console.error("[PDF] Erro ao gerar PDF de rede:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Mapping endpoints (Amil ↔ Koter refnets) ──────────────────────────

  app.get("/api/mappings", (req, res) => {
    const estado = req.query.estado as string | undefined;
    res.json(getAllMappings(estado));
  });

  app.post("/api/mappings", (req, res) => {
    try {
      const { amilNome, amilCidade, amilEstado, koterRefnetId, koterRefnetName } = req.body;
      if (!amilNome || !amilCidade || !koterRefnetId) {
        res.status(400).json({ error: "amilNome, amilCidade e koterRefnetId são obrigatórios" });
        return;
      }
      const mapping = upsertMapping({
        amilNome,
        amilCidade,
        amilEstado: amilEstado || "",
        koterRefnetId,
        koterRefnetName: koterRefnetName || "",
        createdAt: "",
      });
      res.json(mapping);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mappings", (req, res) => {
    const { nome, cidade } = req.query as { nome: string; cidade: string };
    if (!nome || !cidade) {
      res.status(400).json({ error: "nome e cidade são obrigatórios" });
      return;
    }
    const ok = deleteMapping(nome, cidade);
    res.json({ deleted: ok });
  });

  app.get("/api/koter-refnets/search", async (req, res) => {
    const { q, estado } = req.query as { q: string; estado?: string };
    if (!q) {
      res.status(400).json({ error: "Parâmetro 'q' é obrigatório" });
      return;
    }
    try {
      const result = await searchKoterRefnetsLive(q, estado);
      res.json(result.refnets);
    } catch (err: any) {
      console.error("[Koter MCP] Erro na busca:", err.message);
      res.status(500).json({ error: "Erro ao buscar no Koter: " + err.message });
    }
  });

  app.post("/api/mappings/auto-match", async (req, res) => {
    try {
      const { providers } = req.body;
      if (!Array.isArray(providers)) {
        res.status(400).json({ error: "Body deve conter { providers: [...] }" });
        return;
      }
      const results = await autoMatchProviders(providers);
      res.json(results);
    } catch (err: any) {
      console.error("[Auto-match] Erro:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mappings/export", (req, res) => {
    try {
      const { providers } = req.body;
      if (!Array.isArray(providers)) {
        res.status(400).json({ error: "Body deve conter { providers: [...] }" });
        return;
      }
      const result = exportForKoter(providers);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── MCP Endpoint (session-aware) ─────────────────────────────────────────
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  // Inject Accept header if missing (some clients like Manus don't send it)
  app.all("/mcp", (req, _res, next) => {
    if (!req.headers.accept || !req.headers.accept.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
    }
    next();
  });

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // If client sends a session ID, reuse that session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session
    const server = new McpServer({
      name: "amil-consulta",
      version: "1.0.0",
    });
    registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    res.on("close", () => {
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        // Keep session alive for a while for multi-request clients
        setTimeout(() => {
          const s = sessions.get(sid);
          if (s) {
            s.transport.close();
            s.server.close();
            sessions.delete(sid);
          }
        }, 5 * 60 * 1000); // 5 min TTL
      }
    });

    await server.connect(transport);

    // Store session after connect so sessionId is available
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { server, transport });
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ─── SPA fallback ─────────────────────────────────────────────────────────
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Amil MCP Server running on http://localhost:${PORT}`);
    console.log(`Web UI:       http://localhost:${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Health:       http://localhost:${PORT}/health`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
