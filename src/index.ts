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

const PORT = parseInt(process.env.PORT || "3001", 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = express();
  app.use(express.json());

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
      const providers = await getProviders({ regiao, estado, linha, tipo_rede });
      res.json(providers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── MCP Endpoint ─────────────────────────────────────────────────────────
  // Inject Accept header if missing (some clients like Manus don't send it)
  app.all("/mcp", (req, _res, next) => {
    if (!req.headers.accept || !req.headers.accept.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
    }
    next();
  });

  app.all("/mcp", async (req, res) => {
    const server = new McpServer({
      name: "amil-consulta",
      version: "1.0.0",
    });
    registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
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
