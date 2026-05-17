import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();

const PORT = process.env.PORT || 3000;
const PORTAL_TOKEN = process.env.PORTAL_TRANSPARENCIA_TOKEN;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

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

app.get("/", (req, res) => {
  res.json({
    status: "online",
    servico: "Consulta PEP por CPF",
    fonte: "Portal da Transparência da CGU"
  });
});

app.get("/api/pep", async (req, res) => {
  try {
    if (!PORTAL_TOKEN) {
      return res.status(500).json({
        erro: "Token da API não configurado no servidor."
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

    const url = new URL("https://api.portaldatransparencia.gov.br/api-de-dados/pep");
    url.searchParams.set("cpf", cpf);
    url.searchParams.set("pagina", pagina);

    const resposta = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "chave-api-dados": PORTAL_TOKEN
      }
    });

    const texto = await resposta.text();

    let dados;
    try {
      dados = texto ? JSON.parse(texto) : [];
    } catch {
      dados = texto;
    }

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        erro: "Falha ao consultar a API do Portal da Transparência.",
        status: resposta.status,
        detalhe: dados
      });
    }

    return res.json({
      fonte: "Portal da Transparência da Controladoria-Geral da União",
      consultaRealizadaEm: new Date().toISOString(),
      parametroPesquisado: {
        cpf
      },
      pagina,
      resultado: dados
    });
  } catch (erro) {
    return res.status(500).json({
      erro: "Erro interno ao consultar PEP.",
      detalhe: erro.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
