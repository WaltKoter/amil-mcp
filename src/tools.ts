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
import { getComercializacaoByState } from "./manual-vendas.js";
import { getKoterCitiesByState } from "./koter-cities.js";

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
}
