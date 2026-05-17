import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { parse } from "csv-parse/sync";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, "data", "pep.csv");

let registrosPep = [];
let indicePorCpf = new Map();
let baseCarregadaEm = null;
let arquivoBase = "pep.csv";

app.use(express.json());

app.use(
  cors({
    origin: FRONTEND_ORIGIN === "*" ? "*" : FRONTEND_ORIGIN
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
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

  let soma = 0;

  for (let i = 0; i < 9; i++) {
    soma += Number(numeros[i]) * (10 - i);
  }

  let digito1 = 11 - (soma % 11);
  if (digito1 >= 10) digito1 = 0;

  if (digito1 !== Number(numeros[9])) return false;

  soma = 0;

  for (let i = 0; i < 10; i++) {
    soma += Number(numeros[i]) * (11 - i);
  }

  let digito2 = 11 - (soma % 11);
  if (digito2 >= 10) digito2 = 0;

  return digito2 === Number(numeros[10]);
}

function normalizarCabecalho(texto) {
  return String(texto || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function obterValor(objeto, nomesPossiveis) {
  for (const nome of nomesPossiveis) {
    if (
      objeto &&
      objeto[nome] !== undefined &&
      objeto[nome] !== null &&
      String(objeto[nome]).trim() !== ""
    ) {
      return String(objeto[nome]).trim();
    }
  }

  return "";
}

function transformarRegistro(linha) {
  const cpf = obterValor(linha, ["cpf"]);
  const nome = obterValor(linha, ["nome"]);
  const siglaFuncao = obterValor(linha, ["sigla_funcao"]);
  const descricaoFuncao = obterValor(linha, ["descricao_funcao"]);
  const nivelFuncao = obterValor(linha, ["nivel_funcao"]);
  const nomeOrgao = obterValor(linha, ["nome_orgao"]);
  const dataInicioExercicio = obterValor(linha, ["data_inicio_exercicio"]);
  const dataFimExercicio = obterValor(linha, ["data_fim_exercicio"]);
  const dataFimCarencia = obterValor(linha, ["data_fim_carencia"]);

  return {
    cpf,
    nome,
    sigla_funcao: siglaFuncao,
    descricao_funcao: descricaoFuncao,
    nivel_funcao: nivelFuncao,
    nome_orgao: nomeOrgao,
    dt_inicio_exercicio: dataInicioExercicio,
    dt_fim_exercicio: dataFimExercicio,
    dt_fim_carencia: dataFimCarencia
  };
}

async function carregarBasePep() {
  const conteudo = await fs.readFile(CSV_PATH, "utf8");

  const linhas = parse(conteudo, {
    delimiter: ";",
    columns: (cabecalhos) => cabecalhos.map(normalizarCabecalho),
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  registrosPep = linhas.map(transformarRegistro);
  indicePorCpf = new Map();

  for (const registro of registrosPep) {
    const cpfLimpo = limparCpf(registro.cpf);

    if (!cpfLimpo) {
      continue;
    }

    if (!indicePorCpf.has(cpfLimpo)) {
      indicePorCpf.set(cpfLimpo, []);
    }

    indicePorCpf.get(cpfLimpo).push(registro);
  }

  const infoArquivo = await fs.stat(CSV_PATH);

  baseCarregadaEm = new Date().toISOString();
  arquivoBase = path.basename(CSV_PATH);

  console.log(`Base PEP carregada com ${registrosPep.length} registros.`);
  console.log(`Arquivo: ${arquivoBase}`);
  console.log(`Última modificação do arquivo: ${infoArquivo.mtime.toISOString()}`);
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    servico: "Consulta PEP por CPF",
    modo: "consulta local em base CSV oficial",
    fonte: "Portal da Transparência da CGU",
    arquivoBase,
    baseCarregadaEm,
    totalRegistros: registrosPep.length
  });
});

app.get("/api/pep", (req, res) => {
  try {
    if (!registrosPep.length) {
      return res.status(500).json({
        erro: "Base PEP não carregada no servidor."
      });
    }

    const cpf = limparCpf(req.query.cpf);
    const pagina = String(req.query.pagina || "1").trim();

    if (!cpf) {
      return res.status(400).json({
        erro: "Informe o CPF para consulta."
      });
    }

    if (!cpfValido(cpf)) {
      return res.status(400).json({
        erro: "CPF inválido. Confira os números informados."
      });
    }

    const resultado = indicePorCpf.get(cpf) || [];

    return res.json({
      fonte: "Portal da Transparência da Controladoria-Geral da União",
      modoConsulta: "base CSV oficial carregada no backend",
      consultaRealizadaEm: new Date().toISOString(),
      baseCarregadaEm,
      arquivoBase,
      parametroPesquisado: {
        cpf
      },
      pagina,
      resultado
    });
  } catch (erro) {
    return res.status(500).json({
      erro: "Erro interno ao consultar PEP.",
      detalhe: erro.message
    });
  }
});

carregarBasePep()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor iniciado na porta ${PORT}`);
    });
  })
  .catch((erro) => {
    console.error("Erro ao carregar a base PEP:", erro);

    app.listen(PORT, () => {
      console.log(`Servidor iniciado na porta ${PORT}, mas a base PEP não foi carregada.`);
    });
  });
