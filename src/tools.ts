import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getPriceTable,
  getProviders,
  getStates,
  getFormOptions,
  ALL_LINHAS,
  REGIOES,
} from "./amil-client.js";
import { getComercializacaoByState, UF_TO_NAME } from "./manual-vendas.js";
import { getKoterCitiesByState } from "./koter-cities.js";
import {
  getAllStoredProviders,
  getProviderStats,
  getProviderStates,
  getAllMappings,
  exportRefnetsForKoter,
  getRefnetIdsByCategoria,
} from "./mapping-store.js";

export function registerTools(server: McpServer) {
  // ─── Tool: get_price_table ───────────────────────────────────────────────

  server.tool(
    "amil_get_price_table",
    "Busca tabela de preços da Amil para um estado, linha de produto, número de vidas, compulsoriedade e coparticipação. Retorna planos com preços por faixa etária.",
    {
      linha: z
        .string()
        .describe(
          `Linha de produto. Valores: ${ALL_LINHAS.map((l) => `"${l.id}" (${l.label})`).join(", ")}`
        ),
      estado: z
        .string()
        .describe(
          'Estado (ex: "SÃO PAULO", "RIO DE JANEIRO", "MINAS GERAIS", "INTERIOR SP - 1", "INTERIOR SP - 2")'
        ),
      numero_vidas: z
        .string()
        .describe(
          'Faixa de vidas. PME: "2", "3 a 4", "5 a 29", "30 a 99". PJ: "100 a 199"'
        ),
      compulsoriedade: z
        .string()
        .describe(
          'PME: "MEI" ou "Demais empresas". PJ: "Compulsório" ou "Livre Adesão"'
        ),
      coparticipacao: z
        .string()
        .describe(
          'Tipo de coparticipação. Opções variam por linha: "Com coparticipação30", "Com coparticipação40", "Com coparticipação parcial", "Sem coparticipação", "Referência"'
        ),
    },
    async (params) => {
      try {
        const plans = await getPriceTable({
          estado: params.estado,
          numero_vidas: params.numero_vidas,
          compulsoriedade: params.compulsoriedade,
          coparticipacao: params.coparticipacao,
          linha: params.linha,
        });

        if (plans.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Nenhum plano encontrado para os parâmetros informados.",
              },
            ],
          };
        }

        const faixas = [
          "0-18", "19-23", "24-28", "29-33", "34-38",
          "39-43", "44-48", "49-53", "54-58", "59+",
        ];

        const result = plans.map((p) => ({
          nome: p.nome,
          acomodacao: p.tipo_acomodacao,
          categoria: p.categoria,
          registro_ans: p.registro_ans,
          precos: {
            [faixas[0]]: p.faixa_0_18,
            [faixas[1]]: p.faixa_19_23,
            [faixas[2]]: p.faixa_24_28,
            [faixas[3]]: p.faixa_29_33,
            [faixas[4]]: p.faixa_34_38,
            [faixas[5]]: p.faixa_39_43,
            [faixas[6]]: p.faixa_44_48,
            [faixas[7]]: p.faixa_49_53,
            [faixas[8]]: p.faixa_54_58,
            [faixas[9]]: p.faixa_59_plus,
          },
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  linha: params.linha,
                  estado: params.estado,
                  vidas: params.numero_vidas,
                  compulsoriedade: params.compulsoriedade,
                  coparticipacao: params.coparticipacao,
                  total_planos: result.length,
                  planos: result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Erro: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: get_network ───────────────────────────────────────────────────

  server.tool(
    "amil_get_network",
    "Busca a rede de prestadores (hospitais/laboratórios) da Amil para uma região, estado e linha de produto.",
    {
      linha: z
        .string()
        .describe(
          `Linha de produto. Valores: ${ALL_LINHAS.map((l) => `"${l.id}" (${l.label})`).join(", ")}`
        ),
      regiao: z
        .string()
        .describe(`Região do Brasil: ${REGIOES.join(", ")}`),
      estado: z
        .string()
        .describe(
          'Estado para busca de rede (use amil_get_states primeiro para obter os valores válidos, ex: "SP e Interior")'
        ),
      tipo_rede: z
        .string()
        .optional()
        .describe('Tipo de rede: "Hospitais" (padrão) ou "Laboratórios"'),
    },
    async (params) => {
      try {
        const providers = await getProviders({
          regiao: params.regiao,
          estado: params.estado,
          linha: params.linha,
          tipo_rede: params.tipo_rede,
        });

        const totalByCategory: Record<string, number> = {};
        for (const [cat, items] of Object.entries(providers)) {
          totalByCategory[cat] = items.length;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  linha: params.linha,
                  regiao: params.regiao,
                  estado: params.estado,
                  tipo_rede: params.tipo_rede || "Hospitais",
                  total_por_categoria: totalByCategory,
                  prestadores: providers,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Erro: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: get_states ────────────────────────────────────────────────────

  server.tool(
    "amil_get_states",
    "Lista os estados disponíveis para uma região e linha (usado para busca de rede de prestadores).",
    {
      regiao: z.string().describe(`Região: ${REGIOES.join(", ")}`),
      linha: z
        .string()
        .describe(
          `Linha de produto. Valores: ${ALL_LINHAS.map((l) => `"${l.id}"`).join(", ")}`
        ),
    },
    async (params) => {
      try {
        const states = await getStates({
          regiao: params.regiao,
          linha: params.linha,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ regiao: params.regiao, estados: states }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Erro: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: get_form_options ──────────────────────────────────────────────

  server.tool(
    "amil_get_form_options",
    "Retorna as opções de formulário disponíveis para uma linha de produto (estados, número de vidas, compulsoriedade, coparticipação, etc).",
    {
      linha: z
        .string()
        .describe(
          `Linha de produto. Valores: ${ALL_LINHAS.map((l) => `"${l.id}" (${l.label})`).join(", ")}`
        ),
    },
    async (params) => {
      const options = getFormOptions(params.linha);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { linha: params.linha, opcoes: options },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─── Tool: list_linhas ──────────────────────────────────────────────────

  server.tool(
    "amil_list_linhas",
    "Lista todas as linhas de produto disponíveis na Amil (PME e PJ).",
    {},
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pme: ALL_LINHAS.filter((l) => !l.id.includes("PJ")),
                pj: ALL_LINHAS.filter((l) => l.id.includes("PJ")),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─── Tool: get_comercializacao ──────────────────────────────────────────

  server.tool(
    "amil_get_comercializacao",
    "Retorna as cidades de comercialização dos produtos Amil PME para um estado, com os IDs das cidades no Koter. Extrai dados do Manual de Vendas PME da Amil. Para produtos regionais, retorna produto + cidades. Para produtos nacionais, retorna apenas as cidades.",
    {
      estado: z
        .string()
        .describe(
          'Estado (UF ou nome completo). Ex: "SP", "RJ", "MG", "São Paulo", "Rio de Janeiro"'
        ),
    },
    async (params) => {
      try {
        const koterCities = await getKoterCitiesByState(params.estado);
        const result = await getComercializacaoByState(params.estado, koterCities);

        const totalRegionalCities = result.produtos_regionais.reduce(
          (sum, p) => sum + p.cidades.length,
          0
        );
        const matched = [
          ...result.produtos_regionais.flatMap((p) => p.cidades),
          ...result.produtos_nacionais,
        ].filter((c) => c.koterCityId).length;
        const total = totalRegionalCities + result.produtos_nacionais.length;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  estado: params.estado,
                  resumo: {
                    produtos_regionais: result.produtos_regionais.length,
                    cidades_regionais: totalRegionalCities,
                    cidades_nacionais: result.produtos_nacionais.length,
                    cidades_com_id_koter: matched,
                    total_cidades: total,
                  },
                  produtos_regionais: result.produtos_regionais,
                  produtos_nacionais: result.produtos_nacionais,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Erro: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: get_stored_providers ─────────────────────────────────────────

  server.tool(
    "amil_get_stored_providers",
    "Lista prestadores Amil armazenados no banco de dados (hospitais/laboratórios). Retorna resultados paginados com filtros por estado, tipo de rede, status de mapeamento e busca por nome/cidade.",
    {
      estado: z.string().optional().describe("Filtrar por estado (ex: SP e Interior, RJ e ES)"),
      tipo_rede: z.string().optional().describe('Tipo: "Hospitais" ou "Laboratórios" (padrão: todos)'),
      status: z.string().optional().describe('"mapped" (já mapeados), "pending" (sem mapeamento), ou vazio para todos'),
      search: z.string().optional().describe("Buscar por nome ou cidade"),
      page: z.number().optional().describe("Página (padrão: 1)"),
      pageSize: z.number().optional().describe("Itens por página (padrão: 50, máx: 200)"),
    },
    async (params) => {
      const result = await getAllStoredProviders({
        estado: params.estado,
        tipoRede: params.tipo_rede,
        status: params.status as any,
        search: params.search,
        page: params.page || 1,
        pageSize: Math.min(params.pageSize || 50, 200),
      });
      const stats = await getProviderStats({
        estado: params.estado,
        tipoRede: params.tipo_rede,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            stats,
            page: params.page || 1,
            pageSize: Math.min(params.pageSize || 50, 200),
            total: result.total,
            providers: result.providers,
          }, null, 2),
        }],
      };
    }
  );

  // ─── Tool: get_provider_stats ──────────────────────────────────────────

  server.tool(
    "amil_get_provider_stats",
    "Retorna estatísticas dos prestadores Amil armazenados: total, mapeados e pendentes. Também lista os estados disponíveis.",
    {
      estado: z.string().optional().describe("Filtrar por estado"),
      tipo_rede: z.string().optional().describe('Filtrar por tipo: "Hospitais" ou "Laboratórios"'),
    },
    async (params) => {
      const stats = await getProviderStats({
        estado: params.estado,
        tipoRede: params.tipo_rede,
      });
      const states = await getProviderStates();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ stats, estados_disponiveis: states }, null, 2),
        }],
      };
    }
  );

  // ─── Tool: get_mappings ───────────────────────────────────────────────

  server.tool(
    "amil_get_mappings",
    "Retorna os mapeamentos Amil → Koter (prestador Amil vinculado a rede referenciada do Koter). Cada mapeamento contém o ID da rede no Koter.",
    {
      estado: z.string().optional().describe("Filtrar por estado (ex: SP, RJ)"),
    },
    async (params) => {
      const mappings = await getAllMappings(params.estado);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: mappings.length,
            mappings,
          }, null, 2),
        }],
      };
    }
  );

  // ─── Tool: export_refnets_for_koter ───────────────────────────────────

  server.tool(
    "amil_export_refnets_for_koter",
    "Exporta os IDs das redes referenciadas mapeadas no formato de importação do Koter, agrupados por categoria Amil. Retorna { [categoria]: { externalApiProductIds: [], productNames: [...], refnetIds: [...] } }.",
    {
      estado: z.string().optional().describe("Filtrar mapeamentos por estado"),
      productNames: z.array(z.string()).optional().describe("Nomes dos produtos (opcional, usa categorias Amil se omitido)"),
    },
    async (params) => {
      const mappings = await getAllMappings(params.estado);
      const providers = mappings.map(m => ({ nome: m.amilNome, cidade: m.amilCidade }));
      const result = await exportRefnetsForKoter(providers, params.productNames);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // ─── Tool: super_route (produto completo) ─────────────────────────────────

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
    if (estadoNorm.length === 2 && UF_TO_NAME[estadoNorm]) return estadoNorm;
    const spMatch = estadoNorm.match(/\bSP\b/);
    if (spMatch) return "SP";
    const rjMatch = estadoNorm.match(/\bRJ\b/);
    if (rjMatch) return "RJ";
    for (const [uf, name] of Object.entries(UF_TO_NAME)) {
      if (norm(name) === estadoNorm) return uf;
    }
    return null;
  }

  server.tool(
    "amil_super_route",
    "Gera produto completo para importação no Koter. Combina tabela de preços da Amil, redes referenciadas mapeadas e áreas de comercialização em um único JSON. Retorna planos com preços, abrangência (regional/nacional), cidade_ids e refnet_ids.",
    {
      linha: z.string().describe("Linha de produto Amil (ex: 'Linha Amil', 'Linha Amil Black', 'Linha Selecionada')"),
      estado: z.string().describe("Estado (ex: 'SÃO PAULO', 'INTERIOR SP - 1', 'RIO DE JANEIRO')"),
      numero_vidas: z.string().describe("Faixa de vidas (ex: '2', '3 a 4', '5 a 29', '30 a 99', '100 a 199')"),
      compulsoriedade: z.string().describe("Tipo de empresa (ex: 'MEI', 'Demais empresas', 'Compulsório', 'Livre Adesão')"),
      coparticipacao: z.string().describe("Coparticipação (ex: 'Com coparticipação30', 'Com coparticipação parcial', 'Sem coparticipação')"),
    },
    async (params) => {
      const { linha, estado, numero_vidas, compulsoriedade, coparticipacao } = params;

      const uf = estadoToUF(estado);
      const linhaInfo = ALL_LINHAS.find(l => l.id === linha);

      const [plans, comercializacao] = await Promise.all([
        getPriceTable({ estado, numero_vidas, compulsoriedade, coparticipacao, linha }),
        (async () => {
          if (!uf) return { produtos_regionais: [] as any[], produtos_nacionais: [] as any[] };
          try {
            const koterCities = await getKoterCitiesByState(uf);
            return await getComercializacaoByState(uf, koterCities);
          } catch {
            return { produtos_regionais: [] as any[], produtos_nacionais: [] as any[] };
          }
        })(),
      ]);

      if (!plans || plans.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ filtros: { linha, estado, numero_vidas, compulsoriedade, coparticipacao }, planos: [] }, null, 2) }] };
      }

      const catKeys = [...new Map(plans.map(p => [p.categoria, p.nome])).entries()];
      const refnetMap: Record<string, string[]> = {};
      await Promise.all(catKeys.map(async ([cat, planName]) => { refnetMap[cat] = await getRefnetIdsByCategoria(cat, estado, planName); }));

      const nacionalCityIds = comercializacao.produtos_nacionais.filter((c: any) => c.koterCityId).map((c: any) => c.koterCityId);
      const normMatch = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

      const planos = plans.map(plan => {
        const catNorm = normMatch(plan.categoria);
        const regionalMatch = comercializacao.produtos_regionais.find((rp: any) => normMatch(rp.produto).includes(catNorm));

        const abrangencia = regionalMatch
          ? { tipo: "REGIONAL", rotulo: regionalMatch.produto, estados: uf ? [uf] : [], observacao: null }
          : { tipo: "NACIONAL", rotulo: "Nacional", estados: uf ? [uf] : [], observacao: null };

        const cidadeIds = regionalMatch
          ? regionalMatch.cidades.filter((c: any) => c.koterCityId).map((c: any) => c.koterCityId)
          : nacionalCityIds;

        return {
          nome: plan.nome, registro_ans: plan.registro_ans, codigo_plano: plan.codigo_plano,
          categoria: plan.categoria, tipo_acomodacao: plan.tipo_acomodacao,
          faixa_vidas: plan.faixa_vidas || numero_vidas,
          faixa_0_18: plan.faixa_0_18, faixa_19_23: plan.faixa_19_23,
          faixa_24_28: plan.faixa_24_28, faixa_29_33: plan.faixa_29_33,
          faixa_34_38: plan.faixa_34_38, faixa_39_43: plan.faixa_39_43,
          faixa_44_48: plan.faixa_44_48, faixa_49_53: plan.faixa_49_53,
          faixa_54_58: plan.faixa_54_58, faixa_59_plus: plan.faixa_59_plus,
          abrangencia,
          area_comercializacao: { cidade_ids: cidadeIds },
          redes_referenciadas: { refnet_ids: refnetMap[plan.categoria] || [] },
        };
      });

      const result = {
        filtros: { linha, linha_rotulo: linhaInfo?.label || linha, estado, numero_vidas, compulsoriedade, coparticipacao },
        planos,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
