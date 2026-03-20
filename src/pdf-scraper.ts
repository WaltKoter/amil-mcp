import puppeteer, { type Browser } from "puppeteer";

const AMIL_BASE = "https://kitcorretoramil.com.br";

// Map our linha IDs to Amil URL paths for price table pages
const LINHA_TO_PRICE_PATH: Record<string, string> = {
  "Linha Amil": "/linha-amil/tabela-de-precos/",
  "Linha Amil Black": "/linha-amil-black/tabela-de-precos-pme/",
  "Linha Selecionada": "/linha-selecionada-pme/tabela-de-precos-pme/",
  "Linha Amil PJ": "/linha-amil-pj/tabela-de-precos-pj/",
  "Linha Amil Black PJ": "/linha-amil-black-pj/tabela-de-precos-pj/",
  "Linha Selecionada PJ": "/linha-selecionada-pj/tabela-de-precos-pj/",
};

// Map our linha IDs to Amil URL paths for network pages
const LINHA_TO_NETWORK_PATH: Record<string, string> = {
  "Linha Amil": "/linha-amil/resumo-da-rede/",
  "Linha Amil Black": "/linha-amil-black/resumo-da-rede-pme/",
  "Linha Selecionada": "/linha-selecionada-pme/resumo-da-rede-pme/",
  "Linha Amil PJ": "/linha-amil-pj/resumo-da-rede-pj/",
  "Linha Amil Black PJ": "/linha-amil-black-pj/resumo-da-rede-pj/",
  "Linha Selecionada PJ": "/linha-selecionada-pj/resumo-da-rede-pj/",
};

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  // Use system Chromium in Docker (set via PUPPETEER_EXECUTABLE_PATH env)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  browserInstance = await puppeteer.launch(launchOptions);
  return browserInstance;
}

// ─── Price Table PDF ────────────────────────────────────────────────────────

export interface PricePdfParams {
  linha: string;
  estado: string;
}

export async function fetchPriceTablePdf(params: PricePdfParams): Promise<Buffer> {
  // The "Baixar PDF" on Amil navigates to tabela-completa-do-estado with query params
  // That page auto-generates the PDF via pdf.kitcorretoramil.com.br
  const url = `${AMIL_BASE}/tabela-completa-do-estado/?estado=${encodeURIComponent(params.estado)}&linha=${encodeURIComponent(params.linha)}`;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Intercept the PDF POST to capture the resulting PDF URL
    let pdfUrl: string | null = null;

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      req.continue();
    });

    // Listen for responses from the PDF service
    page.on("response", async (response) => {
      const respUrl = response.url();
      if (respUrl.includes("pdf.kitcorretoramil.com.br/pdf") && !respUrl.endsWith(".pdf")) {
        try {
          const json = await response.json();
          if (json && json.path) {
            pdfUrl = `https://pdf.kitcorretoramil.com.br/pdf/${json.path}`;
          }
        } catch { /* not json */ }
      }
    });

    // Navigate to the full table page - this auto-loads all data and triggers PDF
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for the PDF to be generated (up to 60s)
    const startTime = Date.now();
    while (!pdfUrl && Date.now() - startTime < 60000) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!pdfUrl) {
      throw new Error("Timeout: PDF da Amil nao foi gerado em 60 segundos");
    }

    // Download the PDF
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Falha ao baixar PDF: ${pdfResponse.status}`);
    }

    const arrayBuffer = await pdfResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    await page.close();
  }
}

// ─── Network PDF ────────────────────────────────────────────────────────────

export interface NetworkPdfParams {
  linha: string;
  regiao: string;
  estado: string;
  tipo_rede?: string;
}

export async function fetchNetworkPdf(params: NetworkPdfParams): Promise<Buffer> {
  const pagePath = LINHA_TO_NETWORK_PATH[params.linha];
  if (!pagePath) {
    throw new Error(`Linha nao suportada para PDF de rede: ${params.linha}`);
  }

  const url = `${AMIL_BASE}${pagePath}`;
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    let pdfUrl: string | null = null;

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      req.continue();
    });

    page.on("response", async (response) => {
      const respUrl = response.url();
      if (respUrl.includes("pdf.kitcorretoramil.com.br/pdf") && !respUrl.endsWith(".pdf")) {
        try {
          const json = await response.json();
          if (json && json.path) {
            pdfUrl = `https://pdf.kitcorretoramil.com.br/pdf/${json.path}`;
          }
        } catch { /* not json */ }
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Fill in the form: regiao, then wait for estado options, then select estado
    // Select regiao
    await page.waitForSelector("#regiao", { timeout: 10000 });
    await page.select("#regiao", params.regiao);

    // Wait for states to load
    await new Promise((r) => setTimeout(r, 2000));

    // Select estado
    await page.waitForSelector("#estado", { timeout: 10000 });
    await page.select("#estado", params.estado);

    // Select tipo_rede if needed (switch tabs Hospitais/Laboratorios)
    if (params.tipo_rede === "Laboratórios") {
      const labTab = await page.$('.type-tab-wrapper [data-type="Laboratórios"], .type-tab-wrapper [value="Laboratórios"]');
      if (labTab) await labTab.click();
    }

    // Wait for table data to load
    await new Promise((r) => setTimeout(r, 5000));

    // Click the "Baixar PDF" / "Impressão Econômica" button
    const pdfBtn = await page.$(".download-pdf.download-econ, .download-pdf:not(.download-econ)");
    if (pdfBtn) {
      await pdfBtn.click();
    } else {
      throw new Error("Botao de PDF nao encontrado na pagina de rede");
    }

    // Wait for PDF generation
    const startTime = Date.now();
    while (!pdfUrl && Date.now() - startTime < 60000) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!pdfUrl) {
      throw new Error("Timeout: PDF de rede da Amil nao foi gerado em 60 segundos");
    }

    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Falha ao baixar PDF de rede: ${pdfResponse.status}`);
    }

    const arrayBuffer = await pdfResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    await page.close();
  }
}

// Cleanup on process exit
process.on("exit", () => {
  if (browserInstance) {
    browserInstance.close().catch(() => {});
  }
});
