import "dotenv/config";
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
  getRefnetIdsByCategoria,
  type AllProvider,
} from "./mapping-store.js";
import {
  searchKoterRefnets as searchKoterRefnetsLive,
  createKoterRefnet,
} from "./koter-client.js";
import { getComercializacaoByState, UF_TO_NAME } from "./manual-vendas.js";
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
      const created = await createKoterRefnet(amilNome, match.id, match.name);

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

  // Bulk create all unmapped providers in Koter (SSE for progress)
  app.get("/api/mappings/bulk-create", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let aborted = false;
    req.on("close", () => { aborted = true; });

    const send = (data: any) => {
      if (!aborted) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const estado = req.query.estado as string | undefined;
      const tipoRede = req.query.tipo_rede as string | undefined;

      // Get all unmapped providers
      let allUnmapped: AllProvider[] = [];
      let pg = 1;
      while (true) {
        const result = await getAllStoredProviders({
          estado,
          tipoRede,
          status: "pending",
          page: pg,
          pageSize: 500,
        });
        allUnmapped = allUnmapped.concat(result.providers);
        if (allUnmapped.length >= result.total || result.providers.length === 0) break;
        pg++;
      }

      if (!allUnmapped.length) {
        send({ type: "done", created: 0, failed: 0, skipped: 0, total: 0 });
        res.end();
        return;
      }

      send({ type: "start", total: allUnmapped.length });

      // Cache resolved cities per state to avoid repeated lookups
      const cityCache: Record<string, Array<{ id: string; name: string }>> = {};
      const normCity = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

      let created = 0, failed = 0, skipped = 0;

      for (let i = 0; i < allUnmapped.length; i++) {
        if (aborted) break;
        const p = allUnmapped[i];

        try {
          // Resolve city
          if (!cityCache[p.estado]) {
            try {
              cityCache[p.estado] = await getKoterCitiesByState(p.estado);
            } catch {
              cityCache[p.estado] = [];
            }
          }

          const cities = cityCache[p.estado];
          const amilCityNorm = normCity(p.cidade);
          const cityMatch = cities.find((c) => normCity(c.name) === amilCityNorm);

          if (!cityMatch) {
            skipped++;
            send({ type: "progress", done: i + 1, total: allUnmapped.length, created, failed, skipped, current: p.nome, status: "skipped", reason: `Cidade "${p.cidade}" não encontrada` });
            continue;
          }

          // Create refnet in Koter
          const refnet = await createKoterRefnet(p.nome, cityMatch.id, cityMatch.name);

          // Auto-map
          await upsertMapping({
            amilNome: p.nome,
            amilCidade: p.cidade,
            amilEstado: p.estado,
            koterRefnetId: refnet.id,
            koterRefnetName: refnet.name,
            createdAt: "",
          });

          created++;
          send({ type: "progress", done: i + 1, total: allUnmapped.length, created, failed, skipped, current: p.nome, status: "created" });

          // Small delay to not hammer the API
          await new Promise((r) => setTimeout(r, 150));
        } catch (err: any) {
          failed++;
          send({ type: "progress", done: i + 1, total: allUnmapped.length, created, failed, skipped, current: p.nome, status: "error", reason: err.message });
        }
      }

      send({ type: "done", created, failed, skipped, total: allUnmapped.length });
    } catch (err: any) {
      send({ type: "error", message: err.message });
    }

    res.end();
  });

  app.post("/api/mappings/export-refnets", async (req, res) => {
    try {
      const { providers, productNames } = req.body;
      if (!Array.isArray(providers)) {
        res.status(400).json({ error: "Body deve conter { providers: [...] }" });
        return;
      }
      const result = await exportRefnetsForKoter(
        providers,
        productNames && productNames.length > 0 ? productNames : undefined
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

  // ─── Super Route (produto completo para Koter) ──────────────────────────

  const ESTADO_TO_REGIAO: Record<string, string> = {
    "BAHIA": "Nordeste", "CEARÁ": "Nordeste", "MARANHÃO": "Nordeste",
    "PARAÍBA": "Nordeste", "PERNAMBUCO": "Nordeste", "RIO GRANDE DO NORTE": "Nordeste",
    "RIO DE JANEIRO": "Sudeste", "SÃO PAULO": "Sudeste", "MINAS GERAIS": "Sudeste",
    "INTERIOR SP - 1": "Sudeste", "INTERIOR SP - 2": "Sudeste",
    "DISTRITO FEDERAL": "Centro-Oeste", "GOIÁS": "Centro-Oeste",
    "PARANÁ": "Sul", "RIO GRANDE DO SUL": "Sul", "SANTA CATARINA": "Sul",
  };

  function estadoToUF(estado: string): string | null {
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    const estadoNorm = norm(estado);
    // Direct UF match
    if (estadoNorm.length === 2 && UF_TO_NAME[estadoNorm]) return estadoNorm;
    // "INTERIOR SP - 1" → "SP"
    const spMatch = estadoNorm.match(/\bSP\b/);
    if (spMatch) return "SP";
    const rjMatch = estadoNorm.match(/\bRJ\b/);
    if (rjMatch) return "RJ";
    // Full name reverse lookup
    for (const [uf, name] of Object.entries(UF_TO_NAME)) {
      if (norm(name) === estadoNorm) return uf;
    }
    return null;
  }

  app.post("/api/super-route", async (req, res) => {
    try {
      const { linha, estado, numero_vidas, compulsoriedade, coparticipacao } = req.body;
      if (!linha || !estado || !numero_vidas || !compulsoriedade || !coparticipacao) {
        res.status(400).json({ error: "Campos obrigatórios: linha, estado, numero_vidas, compulsoriedade, coparticipacao" });
        return;
      }

      const uf = estadoToUF(estado);
      const regiao = ESTADO_TO_REGIAO[estado] || ESTADO_TO_REGIAO[estado.toUpperCase()] || "Sudeste";
      const linhaInfo = ALL_LINHAS.find(l => l.id === linha);

      // 1. Fetch price table + comercialização in parallel
      const [plans, comercializacao] = await Promise.all([
        getPriceTable({ estado, numero_vidas, compulsoriedade, coparticipacao, linha }),
        (async () => {
          if (!uf) return { produtos_regionais: [], produtos_nacionais: [] };
          try {
            const koterCities = await getKoterCitiesByState(uf);
            return await getComercializacaoByState(uf, koterCities);
          } catch (err: any) {
            console.warn("[Super Route] Comercialização error:", err.message);
            return { produtos_regionais: [], produtos_nacionais: [] };
          }
        })(),
      ]);

      if (!plans || plans.length === 0) {
        res.json({ filtros: { linha, linha_rotulo: linhaInfo?.label || linha, estado, numero_vidas, compulsoriedade, coparticipacao }, planos: [] });
        return;
      }

      // 2. Collect unique categorias (with plan names) and fetch refnet IDs
      const catKeys = [...new Map(plans.map(p => [p.categoria, p.nome])).entries()];
      const refnetMap: Record<string, string[]> = {};
      await Promise.all(catKeys.map(async ([cat, planName]) => {
        refnetMap[cat] = await getRefnetIdsByCategoria(cat, estado, planName);
      }));

      // 3. Pre-compute nacional city IDs (filtered to non-null)
      const nacionalCityIds = comercializacao.produtos_nacionais
        .filter(c => c.koterCityId)
        .map(c => c.koterCityId!);

      // 4. Normalize helper for regional matching
      const normMatch = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

      // 5. Build enriched plans
      const planos = plans.map(plan => {
        // Match plan's categoria to a regional product from comercializacao
        const catNorm = normMatch(plan.categoria);
        const regionalMatch = comercializacao.produtos_regionais.find(rp =>
          normMatch(rp.produto).includes(catNorm)
        );

        let abrangencia;
        let cidadeIds: string[];

        if (regionalMatch) {
          cidadeIds = regionalMatch.cidades
            .filter(c => c.koterCityId)
            .map(c => c.koterCityId!);
          abrangencia = {
            tipo: "REGIONAL",
            rotulo: regionalMatch.produto,
            estados: uf ? [uf] : [],
            observacao: null,
          };
        } else {
          cidadeIds = nacionalCityIds;
          abrangencia = {
            tipo: "NACIONAL",
            rotulo: "Nacional",
            estados: uf ? [uf] : [],
            observacao: null,
          };
        }

        return {
          nome: plan.nome,
          registro_ans: plan.registro_ans,
          codigo_plano: plan.codigo_plano,
          categoria: plan.categoria,
          tipo_acomodacao: plan.tipo_acomodacao,
          faixa_vidas: plan.faixa_vidas || numero_vidas,
          faixa_0_18: plan.faixa_0_18,
          faixa_19_23: plan.faixa_19_23,
          faixa_24_28: plan.faixa_24_28,
          faixa_29_33: plan.faixa_29_33,
          faixa_34_38: plan.faixa_34_38,
          faixa_39_43: plan.faixa_39_43,
          faixa_44_48: plan.faixa_44_48,
          faixa_49_53: plan.faixa_49_53,
          faixa_54_58: plan.faixa_54_58,
          faixa_59_plus: plan.faixa_59_plus,
          abrangencia,
          area_comercializacao: {
            cidade_ids: cidadeIds,
          },
          redes_referenciadas: {
            refnet_ids: refnetMap[plan.categoria] || [],
          },
        };
      });

      res.json({
        filtros: {
          linha,
          linha_rotulo: linhaInfo?.label || linha,
          estado,
          numero_vidas,
          compulsoriedade,
          coparticipacao,
        },
        planos,
      });
    } catch (err: any) {
      console.error("[Super Route] Erro:", err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  // Also support GET for easier testing
  app.get("/api/super-route/test", (_req, res) => {
    res.json({ status: "ok", endpoint: "POST /api/super-route" });
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
