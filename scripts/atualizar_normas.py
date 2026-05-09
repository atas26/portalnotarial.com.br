import base64
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urljoin

import fitz
import requests
from bs4 import BeautifulSoup


GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
GITHUB_OWNER = os.getenv("GITHUB_OWNER", "atas26")
GITHUB_REPO = os.getenv("GITHUB_REPO", "ferramentas-notariais")
GITHUB_BRANCH = os.getenv("GITHUB_BRANCH", "main")

TJSP_URL = os.getenv(
    "TJSP_URL",
    "https://api.tjsp.jus.br/Handlers/Handler/FileFetch.ashx?codigo=179577"
)

CNJ_PAGE_URL = os.getenv(
    "CNJ_PAGE_URL",
    "https://atos.cnj.jus.br/atos/detalhar/5243"
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 atualizador-normas-notariais/1.0"
}


def conferir_variaveis():
    if not GITHUB_TOKEN:
        print("Erro: variável GITHUB_TOKEN não configurada no Render.")
        sys.exit(1)


def baixar_arquivo(url):
    print(f"Baixando: {url}")
    resposta = requests.get(url, headers=HEADERS, timeout=180)
    resposta.raise_for_status()
    return resposta.content


def descobrir_pdf_compilado_cnj():
    print("Procurando o PDF de Texto Compilado do CNJ...")
    html = requests.get(CNJ_PAGE_URL, headers=HEADERS, timeout=120).text
    soup = BeautifulSoup(html, "html.parser")

    for link in soup.find_all("a"):
        texto = link.get_text(" ", strip=True)
        href = link.get("href", "")

        if "Texto Compilado" in texto and href:
            pdf_url = urljoin(CNJ_PAGE_URL, href)
            print(f"PDF compilado localizado: {pdf_url}")
            return pdf_url

    raise RuntimeError("Não foi possível localizar o link Texto Compilado na página do CNJ.")


def extrair_texto_pdf(pdf_bytes):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    partes = []

    for pagina in doc:
        partes.append(pagina.get_text("text"))

    return "\n".join(partes)


def limpar_linha(linha):
    linha = linha.replace("\u00ad", "")
    linha = linha.replace("\x02", "")
    linha = linha.strip()
    linha = re.sub(r"\s+", " ", linha)
    return linha


def linha_inutil_sp(linha):
    if not linha:
        return True

    if re.match(r"^Cap\.\s*[–-]\s*[XVI]+$", linha):
        return True

    if re.match(r"^\d+$", linha):
        return True

    if linha in {
        "PROVIMENTO Nº 58/89",
        "Sumário",
        "CORREGEDORIA GERAL DA JUSTIÇA DO ESTADO DE SÃO PAULO",
    }:
        return True

    return False


def parece_nota_sp(linha):
    return bool(
        re.match(
            r"^\d{1,4}\s+(Prov\.|Provs\.|L\.|Lei|LC|DL|D\.|CJE|RITJ|Proc\.|Com\.|Res\.|Art\.)",
            linha
        )
    )


def formatar_paragrafos(linhas):
    paragrafos = []
    atual = ""

    inicios = (
        "§",
        "I ",
        "II ",
        "III ",
        "IV ",
        "V ",
        "VI ",
        "VII ",
        "VIII ",
        "IX ",
        "X ",
        "XI ",
        "XII ",
        "a)",
        "b)",
        "c)",
        "d)",
        "e)",
        "f)",
        "g)",
        "h)",
        "i)",
        "j)",
        "k)",
        "l)",
        "m)",
        "n)",
    )

    for linha in linhas:
        linha = limpar_linha(linha)

        if not linha:
            if atual:
                paragrafos.append(atual)
                atual = ""
            continue

        if linha.startswith(inicios):
            if atual:
                paragrafos.append(atual)
                atual = ""
            paragrafos.append(linha)
            continue

        if atual:
            atual += " " + linha
        else:
            atual = linha

    if atual:
        paragrafos.append(atual)

    return "\n\n".join(paragrafos)


CAPITULOS_SP = {
    "XIII": "Capítulo XIII - Disposições gerais, função correcional, livros, classificadores e emolumentos",
    "XIV": "Capítulo XIV - Pessoal dos serviços extrajudiciais",
    "XV": "Capítulo XV - Tabelionato de Protesto",
    "XVI": "Capítulo XVI - Tabelionato de Notas",
    "XVII": "Capítulo XVII - Registro Civil das Pessoas Naturais",
    "XVIII": "Capítulo XVIII - Registro Civil das Pessoas Jurídicas",
    "XIX": "Capítulo XIX - Registro de Títulos e Documentos",
    "XX": "Capítulo XX - Registro de Imóveis",
}

AREAS_SP = {
    "XIII": "Disposições gerais",
    "XIV": "Pessoal dos serviços extrajudiciais",
    "XV": "Tabelionato de Protesto",
    "XVI": "Tabelionato de Notas",
    "XVII": "Registro Civil das Pessoas Naturais",
    "XVIII": "Registro Civil das Pessoas Jurídicas",
    "XIX": "Registro de Títulos e Documentos",
    "XX": "Registro de Imóveis",
}

ORDEM_SP = {
    "XIII": 100000,
    "XIV": 200000,
    "XV": 300000,
    "XVI": 400000,
    "XVII": 500000,
    "XVIII": 600000,
    "XIX": 700000,
    "XX": 800000,
}


def numero_item(linha):
    achou = re.match(r"^(\d+[A-Z]?(?:\.\d+)*\.?)\s+", linha)
    if not achou:
        return None

    return achou.group(1).rstrip(".")


def valor_item(numero):
    partes = re.findall(r"\d+", numero)

    if not partes:
        return 0

    valor = int(partes[0])
    divisor = 1000

    for parte in partes[1:]:
        valor += int(parte) / divisor
        divisor *= 1000

    return valor


def parse_sp(texto):
    print("Organizando Normas da Corregedoria de São Paulo...")

    artigos = []
    capitulo_atual = None
    secao_atual = ""
    item_atual = None

    for bruto in texto.splitlines():
        linha = limpar_linha(bruto)

        if linha_inutil_sp(linha):
            continue

        achou_capitulo = re.match(r"^CAPÍTULO\s+([XVI]+)", linha, re.I)
        if achou_capitulo:
            romano = achou_capitulo.group(1).upper()
            if romano in CAPITULOS_SP:
                capitulo_atual = romano
                secao_atual = ""
            continue

        if re.match(r"^SEÇÃO\s+[IVXLCDM]+", linha, re.I) or re.match(r"^Subseção\s+[IVXLCDM]+", linha, re.I):
            secao_atual = linha.title()
            continue

        if not capitulo_atual:
            continue

        if parece_nota_sp(linha):
            if item_atual is not None:
                item_atual["notas"].append(linha)
            continue

        numero = numero_item(linha)

        if numero:
            if item_atual is not None:
                item_atual["texto"] = formatar_paragrafos(item_atual.pop("_linhas"))
                artigos.append(item_atual)

            ordem = ORDEM_SP[capitulo_atual] + valor_item(numero)
            item_id = f"sp-cap-{capitulo_atual.lower()}-item-{numero.lower().replace('.', '-')}"

            item_atual = {
                "id": item_id,
                "numero": f"Cap. {capitulo_atual}, item {numero}",
                "ordem": ordem,
                "tipo": "item",
                "capitulo": CAPITULOS_SP[capitulo_atual],
                "secao": secao_atual,
                "areas": [AREAS_SP[capitulo_atual]],
                "temas": [],
                "norma": True,
                "notas": [],
                "_linhas": [linha],
            }

        elif item_atual is not None:
            item_atual["_linhas"].append(linha)

    if item_atual is not None:
        item_atual["texto"] = formatar_paragrafos(item_atual.pop("_linhas"))
        artigos.append(item_atual)

    return artigos


def classificar_area_cnj(texto):
    base = texto.lower()
    areas = []

    if any(x in base for x in ["tabelião de notas", "tabelionato de notas", "ato notarial", "escritura pública", "ata notarial", "e-notariado"]):
        areas.append("Tabelionato de Notas")

    if "registro civil das pessoas naturais" in base:
        areas.append("Registro Civil das Pessoas Naturais")

    if "registro de imóveis" in base or "registrador de imóveis" in base:
        areas.append("Registro de Imóveis")

    if "protesto" in base:
        areas.append("Tabelionato de Protesto")

    if "registro de títulos e documentos" in base or "registro civil das pessoas jurídicas" in base:
        areas.append("Registro de Títulos e Documentos e Civil das Pessoas Jurídicas")

    if "apostil" in base:
        areas.append("Apostilamento")

    if any(x in base for x in ["proteção de dados", "lgpd", "sistema eletrônico", "certificado digital", "tecnologia"]):
        areas.append("Tecnologia e proteção de dados")

    if not areas:
        areas.append("Disposições gerais")

    return sorted(set(areas))


def ordem_artigo(numero):
    achou = re.match(r"(\d+)(?:-?([A-Z]))?", numero.upper())

    if not achou:
        return 0

    base = int(achou.group(1))
    letra = achou.group(2)

    if letra:
        return base + (ord(letra) - 64) / 100

    return base


def parse_cnj(texto):
    print("Organizando Código Nacional de Normas...")

    artigos = []
    capitulo_atual = ""
    artigo_atual = None
    iniciar = False

    for bruto in texto.splitlines():
        linha = limpar_linha(bruto)

        if not linha:
            continue

        if "CÓDIGO NACIONAL DE NORMAS" in linha.upper():
            iniciar = True

        if not iniciar:
            continue

        if re.match(r"^CAPÍTULO\s+[IVXLCDM]+", linha, re.I):
            capitulo_atual = linha.title()
            continue

        achou_artigo = re.match(r"^Art\.\s*(\d+[A-Z]?)(?:\.|º|\.º)?\s*(.*)", linha)

        if achou_artigo:
            if artigo_atual is not None:
                artigo_atual["texto"] = formatar_paragrafos(artigo_atual.pop("_linhas"))
                artigo_atual["areas"] = classificar_area_cnj(artigo_atual["texto"] + " " + artigo_atual.get("capitulo", ""))
                artigos.append(artigo_atual)

            numero = achou_artigo.group(1)
            ordem = ordem_artigo(numero)

            artigo_atual = {
                "id": f"cnj-art-{numero.lower()}",
                "numero": f"Art. {numero}",
                "ordem": ordem,
                "tipo": "artigo",
                "capitulo": capitulo_atual or "Código Nacional de Normas",
                "secao": "",
                "areas": [],
                "temas": [],
                "norma": True,
                "notas": [],
                "_linhas": [linha],
            }

        elif artigo_atual is not None:
            artigo_atual["_linhas"].append(linha)

    if artigo_atual is not None:
        artigo_atual["texto"] = formatar_paragrafos(artigo_atual.pop("_linhas"))
        artigo_atual["areas"] = classificar_area_cnj(artigo_atual["texto"] + " " + artigo_atual.get("capitulo", ""))
        artigos.append(artigo_atual)

    return artigos


def github_get_file(path):
    url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/contents/{path}"

    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
    }

    resposta = requests.get(
        url,
        headers=headers,
        params={"ref": GITHUB_BRANCH},
        timeout=60,
    )

    if resposta.status_code == 404:
        return None

    resposta.raise_for_status()
    return resposta.json()


def github_put_file(path, content_bytes, message, existing_sha=None):
    url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/contents/{path}"

    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
    }

    payload = {
        "message": message,
        "content": base64.b64encode(content_bytes).decode("utf-8"),
        "branch": GITHUB_BRANCH,
    }

    if existing_sha:
        payload["sha"] = existing_sha

    resposta = requests.put(url, headers=headers, json=payload, timeout=120)
    resposta.raise_for_status()
    return resposta.json()


def json_antigo_tem_mesmo_hash(path, novo_hash):
    existente = github_get_file(path)

    if not existente:
        return False, None

    try:
        conteudo = base64.b64decode(existente["content"]).decode("utf-8")
        payload = json.loads(conteudo)
        return payload.get("sha256") == novo_hash, existente["sha"]
    except Exception:
        return False, existente["sha"]


def atualizar_base(nome, source_url, target_path, pdf_bytes, artigos):
    sha256 = hashlib.sha256(pdf_bytes).hexdigest()
    mesmo_hash, file_sha = json_antigo_tem_mesmo_hash(target_path, sha256)

    if mesmo_hash:
        print(f"{nome}: sem alteração. Nenhum commit será feito.")
        return

    if len(artigos) < 20:
        raise RuntimeError(f"{nome}: poucos itens extraídos. Conferir extração antes de publicar.")

    payload = {
        "source": source_url,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "sha256": sha256,
        "totalItems": len(artigos),
        "articles": artigos,
    }

    content_bytes = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")

    github_put_file(
        target_path,
        content_bytes,
        f"Atualiza {nome} em {datetime.now().strftime('%d/%m/%Y')}",
        existing_sha=file_sha,
    )

    print(f"{nome}: atualizado com {len(artigos)} itens.")


def main():
    conferir_variaveis()

    print("Iniciando atualização das normas.")

    pdf_sp = baixar_arquivo(TJSP_URL)
    texto_sp = extrair_texto_pdf(pdf_sp)
    artigos_sp = parse_sp(texto_sp)

    atualizar_base(
        "Normas CGJ-SP",
        TJSP_URL,
        "dados/normas-sp.json",
        pdf_sp,
        artigos_sp,
    )

    cnj_pdf_url = descobrir_pdf_compilado_cnj()
    pdf_cnj = baixar_arquivo(cnj_pdf_url)
    texto_cnj = extrair_texto_pdf(pdf_cnj)
    artigos_cnj = parse_cnj(texto_cnj)

    atualizar_base(
        "Código Nacional de Normas",
        cnj_pdf_url,
        "dados/normas-nacional.json",
        pdf_cnj,
        artigos_cnj,
    )

    print("Rotina concluída.")


if __name__ == "__main__":
    main()
