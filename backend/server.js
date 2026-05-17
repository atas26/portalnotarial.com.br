import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const app = express();

const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, "data", "pep.csv");

let indicePorCpfCompleto = new Map();
let indicePorMioloCpf = new Map();

let totalRegistros = 0;
let totalCpfsIndexados = 0;
let totalMiolosIndexados = 0;
let baseStatus = "iniciando";
let baseErro = null;
let baseCarregadaEm = null;
let arquivoBase = "pep.csv";
let ultimaModificacaoArquivo = null;
let camposDetectados = [];

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

function obterMioloCpf(cpf) {
  const numeros = limparCpf(cpf);

  if (numeros.length === 11) {
    return numeros.slice(3, 9);
  }

  if (numeros.length === 6) {
    return numeros;
  }

  return "";
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

function separarLinhaCsv(linha, delimitador) {
  const campos = [];
  let atual = "";
  let dentroDeAspas = false;

  for (let i = 0; i < linha.length; i++) {
    const caractere = linha[i];
    const proximo = linha[i + 1];

    if (caractere === '"') {
      if (dentroDeAspas && proximo === '"') {
        atual += '"';
        i++;
      } else {
        dentroDeAspas = !dentroDeAspas;
      }
      continue;
    }

    if (caractere === delimitador && !dentroDeAspas) {
      campos.push(atual.trim());
      atual = "";
      continue;
    }

    atual += caractere;
  }

  campos.push(atual.trim());

  return campos;
}

function detectarDelimitador(linhaCabecalho) {
  const porPontoEVirgula = separarLinhaCsv(linhaCabecalho, ";").length;
  const porVirgula = separarLinhaCsv(linhaCabecalho, ",").length;

  return porPontoEVirgula >= porVirgula ? ";" : ",";
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
  const nome = obterValor(linha, ["nome", "nome_pep", "nome_pessoa"]);
  const siglaFuncao = obterValor(linha, ["sigla_funcao"]);
  const descricaoFuncao = obterValor(linha, ["descricao_funcao", "funcao", "descricao_da_funcao"]);
  const nivelFuncao = obterValor(linha, ["nivel_funcao"]);
  const codOrgao = obterValor(linha, ["cod_orgao", "codigo_orgao"]);
  const nomeOrgao = obterValor(linha, ["nome_orgao", "orgao", "nome_do_orgao"]);
  const dataInicioExercicio = obterValor(linha, ["dt_inicio_exercicio", "data_inicio_exercicio"]);
  const dataFimExercicio = obterValor(linha, ["dt_fim_exercicio", "data_fim_exercicio"]);
  const dataFimCarencia = obterValor(linha, ["dt_fim_carencia", "data_fim_carencia"]);

  return {
    cpf,
    nome,
    sigla_funcao: siglaFuncao,
    descricao_funcao: descricaoFuncao,
    nivel_funcao: nivelFuncao,
    cod_orgao: codOrgao,
    nome_orgao: nomeOrgao,
    dt_inicio_exercicio: dataInicioExercicio,
    dt_fim_exercicio: dataFimExercicio,
    dt_fim_carencia: dataFimCarencia
  };
}

function adicionarAoIndice(indice, chave, registro) {
  if (!chave) {
    return;
  }

  if (!indice.has(chave)) {
    indice.set(chave, []);
  }

  indice.get(chave).push(registro);
}

async function carregarBasePep() {
  try {
    baseStatus = "carregando";
    baseErro = null;

    await fsp.access(CSV_PATH);

    const infoArquivo = await fsp.stat(CSV_PATH);

    arquivoBase = path.basename(CSV_PATH);
    ultimaModificacaoArquivo = infoArquivo.mtime.toISOString();

    const stream = fs.createReadStream(CSV_PATH, {
      encoding: "latin1"
    });

    const leitor = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    let cabecalhos = null;
    let delimitador = ";";

    const novoIndiceCpfCompleto = new Map();
    const novoIndiceMiolo = new Map();

    let contadorRegistros = 0;

    for await (const linhaOriginal of leitor) {
      const linha = String(linhaOriginal || "").trim();

      if (!linha) {
        continue;
      }

      if (!cabecalhos) {
        delimitador = detectarDelimitador(linha);
        cabecalhos = separarLinhaCsv(linha, delimitador).map(normalizarCabecalho);
        camposDetectados = cabecalhos;

        if (!cabecalhos.includes("cpf")) {
          throw new Error(
            `Campo CPF não localizado no cabeçalho do CSV. Campos detectados: ${cabecalhos.join(", ")}`
          );
        }

        continue;
      }

      const valores = separarLinhaCsv(linha, delimitador);
      const objeto = {};

      for (let i = 0; i < cabecalhos.length; i++) {
        objeto[cabecalhos[i]] = valores[i] || "";
      }

      const registro = transformarRegistro(objeto);
      const cpfLimpoDaBase = limparCpf(registro.cpf);
      const mioloDaBase = obterMioloCpf(registro.cpf);

      contadorRegistros++;

      if (cpfLimpoDaBase.length === 11) {
        adicionarAoIndice(novoIndiceCpfCompleto, cpfLimpoDaBase, {
          ...registro,
          tipo_correspondencia: "cpf_completo"
        });
      }

      if (mioloDaBase.length === 6) {
        adicionarAoIndice(novoIndiceMiolo, mioloDaBase, {
          ...registro,
          tipo_correspondencia: "cpf_mascarado_compativel"
        });
      }
    }

    indicePorCpfCompleto = novoIndiceCpfCompleto;
    indicePorMioloCpf = novoIndiceMiolo;

    totalRegistros = contadorRegistros;
    totalCpfsIndexados = novoIndiceCpfCompleto.size;
    totalMiolosIndexados = novoIndiceMiolo.size;

    baseCarregadaEm = new Date().toISOString();
    baseStatus = "pronta";

    console.log("Base PEP carregada.");
    console.log(`Arquivo: ${arquivoBase}`);
    console.log(`Registros lidos: ${totalRegistros}`);
    console.log(`CPFs completos indexados: ${totalCpfsIndexados}`);
    console.log(`Miolos de CPF indexados: ${totalMiolosIndexados}`);
  } catch (erro) {
    baseStatus = "erro";
    baseErro = erro.message;
    totalRegistros = 0;
    totalCpfsIndexados = 0;
    totalMiolosIndexados = 0;
    indicePorCpfCompleto = new Map();
    indicePorMioloCpf = new Map();

    console.error("Erro ao carregar a base PEP:", erro);
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    servico: "Consulta PEP por CPF",
    modo: "consulta local em base CSV oficial",
    observacao: "A base pública de PEP pode trazer CPF mascarado. Nesse caso, a consulta por CPF completo é feita pelo trecho central disponível no arquivo.",
    fonte: "Portal da Transparência da CGU",
    baseStatus,
    baseErro,
    arquivoBase,
    baseCarregadaEm,
    ultimaModificacaoArquivo,
    totalRegistros,
    totalCpfsIndexados,
    totalMiolosIndexados,
    camposDetectados
  });
});

app.get("/debug-base", (req, res) => {
  res.json({
    baseStatus,
    baseErro,
    caminhoEsperadoDoArquivo: CSV_PATH,
    arquivoBase,
    baseCarregadaEm,
    ultimaModificacaoArquivo,
    totalRegistros,
    totalCpfsIndexados,
    totalMiolosIndexados,
    camposDetectados
  });
});

app.get("/api/pep", (req, res) => {
  try {
    if (baseStatus === "carregando" || baseStatus === "iniciando") {
      return res.status(503).json({
        erro: "Base PEP ainda está sendo carregada. Tente novamente em alguns instantes.",
        baseStatus
      });
    }

    if (baseStatus === "erro") {
      return res.status(500).json({
        erro: "Base PEP não foi carregada no servidor.",
        detalhe: baseErro,
        caminhoEsperadoDoArquivo: CSV_PATH
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

    const mioloCpfPesquisado = obterMioloCpf(cpf);

    let resultado = indicePorCpfCompleto.get(cpf) || [];
    let tipoConsulta = "cpf_completo";

    if (!resultado.length && mioloCpfPesquisado) {
      resultado = indicePorMioloCpf.get(mioloCpfPesquisado) || [];
      tipoConsulta = "cpf_mascarado_compativel";
    }

    return res.json({
      fonte: "Portal da Transparência da Controladoria-Geral da União",
      modoConsulta: "base CSV oficial carregada no backend",
      observacao: "Quando a base contém CPF mascarado, o resultado indica compatibilidade com o trecho central do CPF, e não confirmação por CPF completo.",
      consultaRealizadaEm: new Date().toISOString(),
      baseCarregadaEm,
      ultimaModificacaoArquivo,
      arquivoBase,
      parametroPesquisado: {
        cpf,
        mioloCpfPesquisado
      },
      tipoConsulta,
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

app.listen(PORT, () => {
  console.log(`Servidor iniciado na porta ${PORT}.`);
  carregarBasePep();
});
