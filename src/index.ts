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
  REGIOES,
} from "./amil-client.js";
import { fetchPriceTablePdf, fetchNetworkPdf } from "./pdf-scraper.js";
import { initDb } from "./db.js";
import {
  getAllMappings,
  upsertMapping,
  deleteMapping,
  autoMatchProviders,
  exportRefnetsForKoter,
  exportCitiesForKoter,
  saveNetworkResults,
  getLastNetworkResults,
  upsertAllProviders,
  getAllStoredProviders,
  getProviderStates,
  getProviderStats,
  clearAllProviders,
  type AllProvider,
} from "./mapping-store.js";
import {
  searchKoterRefnets as searchKoterRefnetsLive,
  createKoterRefnet,
} from "./koter-client.js";
import { getComercializacaoByState } from "./manual-vendas.js";
import { getKoterCitiesByState } from "./koter-cities.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await initDb();

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
      await saveNetworkResults(flat, { regiao, estado, linha, tipo_rede: tipo_rede || "Hospitais" });

      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/network/last-results", async (_req, res) => {
    res.json(await getLastNetworkResults());
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

  app.get("/api/mappings", async (req, res) => {
    const estado = req.query.estado as string | undefined;
    res.json(await getAllMappings(estado));
  });

  app.post("/api/mappings", async (req, res) => {
    try {
      const { amilNome, amilCidade, amilEstado, koterRefnetId, koterRefnetName } = req.body;
      if (!amilNome || !amilCidade || !koterRefnetId) {
        res.status(400).json({ error: "amilNome, amilCidade e koterRefnetId são obrigatórios" });
        return;
      }
      const mapping = await upsertMapping({
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

  app.delete("/api/mappings", async (req, res) => {
    const { nome, cidade } = req.query as { nome: string; cidade: string };
    if (!nome || !cidade) {
      res.status(400).json({ error: "nome e cidade são obrigatórios" });
      return;
    }
    const ok = await deleteMapping(nome, cidade);
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

  // Create refnet in Koter and auto-map
  app.post("/api/mappings/create-and-map", async (req, res) => {
    try {
      const { amilNome, amilCidade, amilEstado } = req.body;
      if (!amilNome || !amilCidade || !amilEstado) {
        res.status(400).json({ error: "amilNome, amilCidade e amilEstado são obrigatórios" });
        return;
      }

      // Resolve city to Koter cityId
      const koterCities = await getKoterCitiesByState(amilEstado);
      const normCity = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
      const amilCityNorm = normCity(amilCidade);
      const match = koterCities.find((c) => normCity(c.name) === amilCityNorm);

      if (!match) {
        res.status(404).json({ error: `Cidade "${amilCidade}" não encontrada no Koter para o estado "${amilEstado}"` });
        return;
      }

      // Create refnet in Koter
      const created = await createKoterRefnet(amilNome, match.id);

      // Auto-map
      await upsertMapping({
        amilNome,
        amilCidade,
        amilEstado,
        koterRefnetId: created.id,
        koterRefnetName: created.name,
        createdAt: "",
      });

      res.json({ created: true, refnetId: created.id, refnetName: created.name, cityId: match.id, cityName: match.name });
    } catch (err: any) {
      console.error("[Create+Map] Erro:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mappings/export-refnets", async (req, res) => {
    try {
      const { providers, productNames } = req.body;
      if (!Array.isArray(providers)) {
        res.status(400).json({ error: "Body deve conter { providers, productNames }" });
        return;
      }
      const result = await exportRefnetsForKoter(
        providers,
        productNames || []
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/comercializacao/export-cities", (req, res) => {
    try {
      const { cityIds, productNames } = req.body;
      if (!Array.isArray(cityIds)) {
        res.status(400).json({ error: "Body deve conter { cityIds, productNames }" });
        return;
      }
      const result = exportCitiesForKoter(
        cityIds,
        productNames || []
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Manual de Vendas PME (Comercialização) ──────────────────────────────

  app.get("/api/comercializacao", async (req, res) => {
    try {
      const estado = req.query.estado as string;
      if (!estado) {
        res.status(400).json({ error: "Parâmetro 'estado' é obrigatório (ex: SP, RJ, MG)" });
        return;
      }
      const koterCities = await getKoterCitiesByState(estado);
      const result = await getComercializacaoByState(estado, koterCities);
      res.json(result);
    } catch (err: any) {
      console.error("[Comercialização] Erro:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── All Providers (fetch entire Amil network) ─────────────────────────────

  app.get("/api/network/all-providers", async (req, res) => {
    const { estado, tipo_rede, status, search, page, pageSize } = req.query as Record<string, string>;
    const result = await getAllStoredProviders({
      estado: estado || undefined,
      tipoRede: tipo_rede || undefined,
      status: status || undefined,
      search: search || undefined,
      page: page ? parseInt(page) : 1,
      pageSize: pageSize ? parseInt(pageSize) : 50,
    });
    res.json(result);
  });

  app.get("/api/network/all-providers/stats", async (req, res) => {
    const { estado, tipo_rede } = req.query as Record<string, string>;
    res.json(await getProviderStats({ estado: estado || undefined, tipoRede: tipo_rede || undefined }));
  });

  app.get("/api/network/all-providers/states", async (_req, res) => {
    res.json(await getProviderStates());
  });

  app.delete("/api/network/all-providers", async (req, res) => {
    const tipoRede = req.query.tipo_rede as string | undefined;
    await clearAllProviders(tipoRede);
    res.json({ cleared: true });
  });

  // SSE endpoint: fetch all providers from Amil across all linhas/regioes/estados
  app.get("/api/network/fetch-all", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const tipoRede = (req.query.tipo_rede as string) || "Hospitais";
    let aborted = false;
    req.on("close", () => { aborted = true; });

    const send = (data: any) => {
      if (!aborted) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const linhas = ALL_LINHAS.map((l) => l.id);
      const regioes = [...REGIOES];

      send({ type: "phase", phase: "states", message: "Descobrindo estados disponíveis..." });
      const combos: Array<{ linha: string; regiao: string; estado: string }> = [];
      let statesDone = 0;
      const totalStateCalls = linhas.length * regioes.length;

      for (const linha of linhas) {
        for (const regiao of regioes) {
          if (aborted) break;
          try {
            const states = await getStates({ regiao, linha });
            for (const s of states) {
              combos.push({ linha, regiao, estado: s.name });
            }
          } catch {}
          statesDone++;
          send({ type: "progress", phase: "states", done: statesDone, total: totalStateCalls });
        }
        if (aborted) break;
      }

      if (aborted) { res.end(); return; }

      const uniqueCombos = [
        ...new Map(combos.map((c) => [`${c.linha}|${c.regiao}|${c.estado}`, c])).values(),
      ];

      send({ type: "phase", phase: "providers", total: uniqueCombos.length, message: `Buscando prestadores (${uniqueCombos.length} combinações)...` });

      let provDone = 0;
      let totalStored = 0;

      for (const combo of uniqueCombos) {
        if (aborted) break;
        try {
          const data = await getProviders({
            regiao: combo.regiao,
            estado: combo.estado,
            linha: combo.linha,
            tipo_rede: tipoRede,
          });

          const batch: AllProvider[] = [];
          for (const [cat, items] of Object.entries(data)) {
            if (!Array.isArray(items)) continue;
            for (const item of items as any[]) {
              const existing = batch.find((b) => b.nome === item.nome && b.cidade === item.cidade);
              if (existing) {
                if (!existing.categorias.includes(cat)) existing.categorias.push(cat);
                if (!existing.linhas.includes(combo.linha)) existing.linhas.push(combo.linha);
              } else {
                batch.push({
                  nome: item.nome,
                  cidade: item.cidade,
                  estado: item.estado || combo.estado,
                  tipoRede: tipoRede,
                  linhas: [combo.linha],
                  categorias: [cat],
                  modalidades: item.modalidades || "",
                });
              }
            }
          }

          if (batch.length) {
            await upsertAllProviders(batch);
            totalStored += batch.length;
          }
        } catch {}

        provDone++;
        if (provDone % 3 === 0 || provDone === uniqueCombos.length) {
          send({ type: "progress", phase: "providers", done: provDone, total: uniqueCombos.length, stored: totalStored });
        }

        await new Promise((r) => setTimeout(r, 80));
      }

      const stats = await getProviderStats({ tipoRede });
      send({ type: "done", stats });
    } catch (err: any) {
      send({ type: "error", message: err.message });
    }

    res.end();
  });

  // ─── MCP Endpoint (session-aware) ─────────────────────────────────────────
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  app.all("/mcp", (req, _res, next) => {
    if (!req.headers.accept || !req.headers.accept.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
    }
    next();
  });

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

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
        setTimeout(() => {
          const s = sessions.get(sid);
          if (s) {
            s.transport.close();
            s.server.close();
            sessions.delete(sid);
          }
        }, 5 * 60 * 1000);
      }
    });

    await server.connect(transport);

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
