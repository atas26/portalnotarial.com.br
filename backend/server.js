import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const PORT = process.env.PORT || 3000;
const PORTAL_TOKEN = process.env.PORTAL_TRANSPARENCIA_TOKEN;
const DEBUG_TOKEN = process.env.DEBUG_TOKEN;
const ORIGENS = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const API_URL = "https://api.portaldatransparencia.gov.br/api-de-dados/pep";
const TTL_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 10000;

const cache = new Map();

app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json());

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ORIGENS.length === 0 || ORIGENS.includes(origin)) return cb(null, true);
      return cb(new Error("Origem não autorizada"));
    }
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      erro: "Muitas consultas em pouco tempo. Aguarde alguns instantes e tente novamente."
    }
  })
);

function limparCpf(cpf) {
  return String(cpf || "").replace(/\D/g, "");
}

function cpfValido(cpf) {
  const numeros = limparCpf(cpf);

  if (numeros.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(numeros)) return false;

  const calc = (base) => {
    let soma = 0;
    for (let i = 0; i < base; i++) {
      soma += Number(numeros[i]) * (base + 1 - i);
    }
    const digito = 11 - (soma % 11);
    return digito >= 10 ? 0 : digito;
  };

  return calc(9) === Number(numeros[9]) && calc(10) === Number(numeros[10]);
}

function respostaEhHtml(texto) {
  const t = String(texto || "").trim().toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html");
}

function mascararCpf(cpf) {
  if (!cpf || cpf.length !== 11) return "***";
  return `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}`;
}

function debugAutorizado(req) {
  if (!DEBUG_TOKEN) return false;
  return req.query.token === DEBUG_TOKEN;
}

async function buscarPep(cpf, pagina) {
  const chave = `${cpf}|${pagina}`;
  const agora = Date.now();
  const cached = cache.get(chave);

  if (cached && cached.expira > agora) {
    return { dados: cached.dados, origem: "cache" };
  }

  const url = `${API_URL}?cpf=${cpf}&pagina=${pagina}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resposta = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "chave-api-dados": PORTAL_TOKEN,
        "User-Agent": "consulta-pep-portal-notarial/1.1"
      }
    });

    const texto = await resposta.text();
    const tipo = resposta.headers.get("content-type") || "";

    if (respostaEhHtml(texto) || !tipo.includes("application/json")) {
      const erro = new Error("Resposta não JSON da CGU");
      erro.status = resposta.status;
      erro.amostra = texto.slice(0, 200);
      throw erro;
    }

    let dados;
    try {
      dados = texto ? JSON.parse(texto) : [];
    } catch {
      const erro = new Error("JSON inválido");
      erro.status = 502;
      erro.amostra = texto.slice(0, 200);
      throw erro;
    }

    if (!resposta.ok) {
      const erro = new Error("Falha na CGU");
      erro.status = resposta.status;
      erro.detalhe = dados;
      throw erro;
    }

    cache.set(chave, { dados, expira: agora + TTL_MS });
    return { dados, origem: "api" };
  } finally {
    clearTimeout(timer);
  }
}

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    servico: "Consulta PEP por CPF",
    fonte: "Portal da Transparência da CGU"
  });
});

app.get("/debug/ip", async (req, res) => {
  if (!debugAutorizado(req)) {
    return res.status(401).json({ erro: "Token de debug inválido." });
  }

  try {
    const r = await fetch("https://api.ipify.org?format=json");
    const ip = await r.json();
    return res.json({
      ipDoRender: ip,
      observacao:
        "Compare esse IP com listas de IPs de provedores cloud. Se estiver em faixa conhecida da AWS, GCP ou Cloudflare usada pelo Render, a CGU pode estar bloqueando."
    });
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
});

app.get("/debug/cgu", async (req, res) => {
  if (!debugAutorizado(req)) {
    return res.status(401).json({ erro: "Token de debug inválido." });
  }

  if (!PORTAL_TOKEN) {
    return res.status(500).json({ erro: "PORTAL_TRANSPARENCIA_TOKEN não configurado." });
  }

  const cpfTeste = limparCpf(req.query.cpf) || "15882240824";
  const pagina = parseInt(req.query.pagina, 10) || 1;
  const url = `${API_URL}?cpf=${cpfTeste}&pagina=${pagina}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "chave-api-dados": PORTAL_TOKEN,
        "User-Agent": "consulta-pep-portal-notarial/1.1"
      }
    });

    const texto = await r.text();
    const headersRecebidos = {};
    r.headers.forEach((valor, nome) => {
      headersRecebidos[nome] = valor;
    });

    return res.json({
      urlChamada: url,
      statusHttp: r.status,
      statusTextHttp: r.statusText,
      contentType: r.headers.get("content-type"),
      tamanhoCorpo: texto.length,
      pareceHtml: respostaEhHtml(texto),
      headersRecebidos,
      amostraInicio: texto.slice(0, 400),
      amostraFim: texto.length > 400 ? texto.slice(-200) : ""
    });
  } catch (e) {
    return res.status(500).json({
      erro: e.message,
      nome: e.name
    });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/api/pep", async (req, res) => {
  try {
    if (!PORTAL_TOKEN) {
      return res.status(500).json({
        erro: "Token da API não configurado no servidor."
      });
    }

    const cpf = limparCpf(req.query.cpf);
    const pagina = parseInt(req.query.pagina, 10) || 1;

    if (!cpf) {
      return res.status(400).json({ erro: "Informe o CPF para consulta." });
    }

    if (!cpfValido(cpf)) {
      return res.status(400).json({ erro: "CPF inválido. Confira os números informados." });
    }

    if (!Number.isInteger(pagina) || pagina < 1 || pagina > 100) {
      return res.status(400).json({ erro: "Parâmetro pagina inválido." });
    }

    const { dados, origem } = await buscarPep(cpf, pagina);

    return res.json({
      fonte: "Portal da Transparência da Controladoria-Geral da União",
      consultaRealizadaEm: new Date().toISOString(),
      parametroPesquisado: { cpf },
      pagina,
      origem,
      resultado: dados
    });
  } catch (erro) {
    console.error("[pep]", {
      cpf: mascararCpf(limparCpf(req.query.cpf)),
      status: erro.status,
      msg: erro.message,
      amostra: erro.amostra
    });

    if (erro.name === "AbortError") {
      return res.status(504).json({
        erro: "Tempo de resposta excedido ao consultar a API oficial."
      });
    }

    if (erro.status && String(erro.amostra || "").length > 0) {
      return res.status(502).json({
        erro: "A API oficial retornou uma página HTML de verificação humana, e não uma resposta JSON.",
        statusRecebidoDaApiOficial: erro.status,
        orientacao:
          "Isso normalmente indica bloqueio ou desafio de segurança no acesso automatizado a partir do servidor. Teste novamente em alguns minutos. Se persistir, será necessário consultar a CGU ou usar a base aberta de download de PEP."
      });
    }

    return res.status(erro.status || 500).json({
      erro: "Erro interno ao consultar PEP.",
      detalhe: erro.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
