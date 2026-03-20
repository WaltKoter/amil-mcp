const BASE_URL = "https://kitcorretoramil.com.br/wp-admin/admin-ajax.php";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceTableParams {
  estado: string;
  numero_vidas: string;
  compulsoriedade: string;
  coparticipacao: string;
  linha: string;
}

export interface NetworkParams {
  regiao: string;
  estado: string;
  linha: string;
  tipo_rede?: string;
  pf?: string;
}

export interface StatesParams {
  regiao: string;
  linha: string;
}

export interface PricePlan {
  nome: string;
  tipo_acomodacao: string;
  faixa_0_18: string;
  faixa_19_23: string;
  faixa_24_28: string;
  faixa_29_33: string;
  faixa_34_38: string;
  faixa_39_43: string;
  faixa_44_48: string;
  faixa_49_53: string;
  faixa_54_58: string;
  faixa_59_plus: string;
  registro_ans: string;
  codigo_plano: string;
  categoria: string;
  faixa_vidas: string;
}

export interface Provider {
  nome: string;
  estado: string;
  regiao: string;
  cidade: string;
  modalidades: string;
  modalidades_extra?: string;
  /** Which sub-category columns this provider accepts (indices into the category's sub-columns) */
  sub_categorias_aceitas?: number[];
}

export interface StateInfo {
  term_id: number;
  name: string;
  slug: string;
}

// ─── Linhas disponíveis ──────────────────────────────────────────────────────

export const LINHAS = {
  PME: [
    { id: "Linha Amil", label: "Linha Amil (PME)" },
    { id: "Linha Amil Black", label: "Linha Amil Black (PME)" },
    { id: "Linha Selecionada", label: "Linha Selecionada (PME)" },
  ],
  PJ: [
    { id: "Linha Amil PJ", label: "Linha Amil (PJ)" },
    { id: "Linha Amil Black PJ", label: "Linha Amil Black (PJ)" },
    { id: "Linha Selecionada PJ", label: "Linha Selecionada (PJ)" },
  ],
} as const;

export const ALL_LINHAS = [...LINHAS.PME, ...LINHAS.PJ];

export const ESTADOS_PME = [
  "BAHIA", "CEARÁ", "DISTRITO FEDERAL", "GOIÁS", "MARANHÃO",
  "MINAS GERAIS", "PARAÍBA", "PARANÁ", "PERNAMBUCO",
  "RIO DE JANEIRO", "RIO GRANDE DO NORTE", "RIO GRANDE DO SUL",
  "SÃO PAULO", "INTERIOR SP - 1", "INTERIOR SP - 2", "SANTA CATARINA",
];

export const ESTADOS_PJ = [
  "BAHIA", "CEARÁ", "DISTRITO FEDERAL", "GOIÁS", "MARANHÃO",
  "MINAS GERAIS", "PARAÍBA", "PARANÁ", "PERNAMBUCO",
  "RIO DE JANEIRO", "RIO GRANDE DO NORTE", "RIO GRANDE DO SUL",
  "SÃO PAULO", "INTERIOR SP - 1", "SANTA CATARINA",
];

export const REGIOES = ["Norte", "Nordeste", "Sul", "Sudeste", "Centro-Oeste"];

export const NUMERO_VIDAS_PME = [
  { value: "2", label: "PME I – 2 vidas" },
  { value: "3 a 4", label: "PME I – 3 a 4 vidas" },
  { value: "5 a 29", label: "PME I – 5 a 29 vidas" },
  { value: "30 a 99", label: "PME II – 30 a 99 vidas" },
];

export const NUMERO_VIDAS_PJ = [
  { value: "100 a 199", label: "PJ – 100 a 199 vidas" },
];

export const COMPULSORIEDADE_PME = [
  { value: "MEI", label: "MEI" },
  { value: "Demais empresas", label: "Demais empresas" },
];

export const COMPULSORIEDADE_PJ = [
  { value: "Compulsório", label: "Compulsório" },
  { value: "Livre Adesão", label: "Livre Adesão" },
];

export const COPARTICIPACAO_PME_AMIL = [
  { value: "Com coparticipação30", label: "Com Coparticipação 30%" },
  { value: "Com coparticipação parcial", label: "Com Coparticipação Parcial TP" },
];

export const COPARTICIPACAO_PME_BLACK = [
  { value: "Com coparticipação30", label: "Com Coparticipação 30%" },
  { value: "Com coparticipação parcial", label: "Com Coparticipação Parcial TP" },
];

export const COPARTICIPACAO_PME_SELECIONADA = [
  { value: "Com coparticipação30", label: "Com Coparticipação 30%" },
  { value: "Com coparticipação parcial", label: "Com Coparticipação Parcial TP" },
];

export const COMPULSORIEDADE_PME_BLACK = [
  { value: "Demais empresas", label: "Demais empresas" },
];

export const COPARTICIPACAO_PJ = [
  { value: "Sem coparticipação", label: "Sem Coparticipação" },
  { value: "Com coparticipação30", label: "Com Coparticipação 30%" },
];

export const MODALIDADES = [
  { value: "", label: "Tudo" },
  { value: "H", label: "H – Hospital Eletivo" },
  { value: "H CARD", label: "H CARD – Hospital Cardiológico" },
  { value: "HD", label: "HD – Hospital Dia" },
  { value: "H ORT", label: "H ORT – Hospital Cirurgia Ortopédica" },
  { value: "M", label: "M – Maternidade" },
  { value: "HP", label: "HP – Hospital Pediátrico" },
  { value: "PA", label: "PA – Pronto Atendimento" },
  { value: "PS", label: "PS – Pronto Socorro" },
  { value: "PS CARD", label: "PS CARD – Pronto Socorro Cardiológico" },
  { value: "PS OBST", label: "PS OBST – Pronto Socorro Obstétrico" },
  { value: "PSI", label: "PSI – Pronto Socorro Infantil" },
  { value: "PSO", label: "PSO – Pronto Socorro Ortopédico" },
];

export const TIPOS_REDE = [
  { value: "Hospitais", label: "Hospitais" },
  { value: "Laboratórios", label: "Laboratórios" },
];

// ─── API Client ──────────────────────────────────────────────────────────────

async function callAmilApi(action: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${BASE_URL}?action=${action}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Amil API error: ${resp.status} ${resp.statusText}`);
  }

  const text = await resp.text();
  if (!text || text === "0") {
    return null;
  }
  return JSON.parse(text);
}

// ─── Get States by Region (for network lookup) ──────────────────────────────

export async function getStates(params: StatesParams): Promise<StateInfo[]> {
  const data = await callAmilApi("ktc_get_states", {
    regiao: params.regiao,
    linha: params.linha,
  });
  if (!data || !Array.isArray(data)) return [];
  return (data as any[]).map((s) => ({
    term_id: s.term_id,
    name: s.name,
    slug: s.slug,
  }));
}

// ─── Get Price Table ─────────────────────────────────────────────────────────

export async function getPriceTable(params: PriceTableParams): Promise<PricePlan[]> {
  const body = {
    Estado: params.estado,
    Numero_de_vidas_plano: params.numero_vidas,
    Compulsorio: params.compulsoriedade,
    "Coparticipação": params.coparticipacao,
    Linha: params.linha,
  };

  const data = await callAmilApi("ktc_get_price_table_values", body);
  if (!data || typeof data !== "object") return [];

  const plans: PricePlan[] = [];
  for (const [, values] of Object.entries(data as Record<string, string[]>)) {
    if (!Array.isArray(values) || values.length < 15) continue;
    plans.push({
      nome: values[0],
      tipo_acomodacao: values[1],
      faixa_0_18: values[2],
      faixa_19_23: values[3],
      faixa_24_28: values[4],
      faixa_29_33: values[5],
      faixa_34_38: values[6],
      faixa_39_43: values[7],
      faixa_44_48: values[8],
      faixa_49_53: values[9],
      faixa_54_58: values[10],
      faixa_59_plus: values[11],
      registro_ans: values[12],
      codigo_plano: values[13],
      categoria: values[14],
      faixa_vidas: values.length > 15 ? values[15] : params.numero_vidas,
    });
  }

  // Filter to only the requested faixa_vidas
  const filtered = plans.filter((p) => p.faixa_vidas === params.numero_vidas);
  return filtered.length > 0 ? filtered : plans;
}

// ─── Get Network / Providers ─────────────────────────────────────────────────

/**
 * Check if a cell value is an X mark (fa-times icon = hospital does NOT accept this sub-category)
 */
function isXMark(val: unknown): boolean {
  if (typeof val !== "string") return false;
  return val.includes("fa-times");
}

/**
 * Check if a cell value is an actual modalidades string (not X mark, not the trailing "0")
 */
function isValidModalidade(val: unknown): boolean {
  if (typeof val !== "string") return false;
  if (val === "0" || val.trim() === "") return false;
  if (isXMark(val)) return false;
  return true;
}

export async function getProviders(params: NetworkParams): Promise<Record<string, Provider[]>> {
  const body: Record<string, string> = {
    regiao: params.regiao,
    estado: params.estado,
    linha: params.linha,
    pf: params.pf || "false",
    "Tipo de Rede": params.tipo_rede || "Hospitais",
  };

  const data = await callAmilApi("ktc_get_providers", body);
  if (!data || typeof data !== "object") return {};

  const result: Record<string, Provider[]> = {};
  for (const [categoria, items] of Object.entries(data as Record<string, unknown[][]>)) {
    if (!Array.isArray(items)) continue;

    const providers: Provider[] = [];
    for (const row of items) {
      if (!Array.isArray(row) || row.length < 5) continue;

      const nome = row[0] as string;
      const estado = row[1] as string;
      const regiao = row[2] as string;
      const cidade = row[3] as string;

      // Columns 4..N-1 are sub-category modalidades, last column is always "0"
      // Each sub-column can be either a modalidades string (accepted) or fa-times HTML (rejected)
      const subCols: unknown[] = [];
      for (let i = 4; i < row.length; i++) {
        // The trailing "0" marks end of data
        if (row[i] === "0" || row[i] === 0) break;
        subCols.push(row[i]);
      }

      // If there are no sub-columns, treat as accepted (e.g., simple row format)
      if (subCols.length === 0) {
        providers.push({ nome, estado, regiao, cidade, modalidades: "" });
        continue;
      }

      // Check which sub-category columns the provider accepts
      const acceptedIndices: number[] = [];
      const acceptedMods: string[] = [];
      for (let i = 0; i < subCols.length; i++) {
        if (!isXMark(subCols[i])) {
          acceptedIndices.push(i);
          if (isValidModalidade(subCols[i])) {
            acceptedMods.push(subCols[i] as string);
          }
        }
      }

      // If ALL sub-columns are X marks → provider does NOT accept this category at all → skip
      if (acceptedIndices.length === 0) {
        continue;
      }

      providers.push({
        nome,
        estado,
        regiao,
        cidade,
        modalidades: acceptedMods[0] || "",
        modalidades_extra: acceptedMods.length > 1 ? acceptedMods.slice(1).join("; ") : undefined,
        sub_categorias_aceitas: acceptedIndices,
      });
    }

    result[categoria] = providers;
  }
  return result;
}

// ─── Get form options for a given linha ──────────────────────────────────────

export function getFormOptions(linha: string) {
  const isPJ = linha.includes("PJ");
  const isBlack = linha.includes("Black");
  const isSelecionada = linha.includes("Selecionada");

  let coparticipacaoOptions;
  let compulsoriedadeOptions;

  if (isPJ) {
    coparticipacaoOptions = COPARTICIPACAO_PJ;
    compulsoriedadeOptions = COMPULSORIEDADE_PJ;
  } else if (isBlack) {
    coparticipacaoOptions = COPARTICIPACAO_PME_BLACK;
    compulsoriedadeOptions = COMPULSORIEDADE_PME_BLACK;
  } else if (isSelecionada) {
    coparticipacaoOptions = COPARTICIPACAO_PME_SELECIONADA;
    compulsoriedadeOptions = COMPULSORIEDADE_PME;
  } else {
    coparticipacaoOptions = COPARTICIPACAO_PME_AMIL;
    compulsoriedadeOptions = COMPULSORIEDADE_PME;
  }

  return {
    estados: isPJ ? ESTADOS_PJ : ESTADOS_PME,
    numero_vidas: isPJ ? NUMERO_VIDAS_PJ : NUMERO_VIDAS_PME,
    compulsoriedade: compulsoriedadeOptions,
    coparticipacao: coparticipacaoOptions,
    regioes: REGIOES,
    modalidades: MODALIDADES,
    tipos_rede: TIPOS_REDE,
  };
}
