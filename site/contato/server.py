"""Formulário de contato do Escribanote.

O endereço de destino existe só aqui no servidor (variável CONTATO_PARA); a página nunca o vê.
Defesas contra robôs, da mais barata para a mais cara:
  1. campo-isca invisível (robôs que preenchem tudo se denunciam);
  2. tempo mínimo entre abrir o desafio e enviar;
  3. prova de trabalho: o navegador precisa achar um número cujo SHA-256 bate com o desafio
     assinado pelo servidor (custa ~1 s para uma pessoa, caro para quem envia em massa);
  4. limite por IP e desafio de uso único;
  5. filtros de conteúdo (links demais, tamanhos).
Toda mensagem aceita é gravada em /data/mensagens.jsonl antes de qualquer envio, então nada se perde
se o e-mail falhar ou ainda não estiver configurado.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
from collections import defaultdict, deque
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get("CONTATO_DATA", "/data")
SECRET = os.environ.get("CONTATO_SEGREDO", "").encode() or secrets.token_bytes(32)
DIFICULDADE = int(os.environ.get("CONTATO_DIFICULDADE", "120000"))
TEMPO_MIN = 3  # segundos entre pedir o desafio e enviar
VALIDADE = 30 * 60
POR_IP_HORA = 5

# Nome com que o servidor se apresenta ao SMTP (o padrão seria o ID do contêiner, que conta como spam).
HELO = os.environ.get("SMTP_HELO", "escribanote.meneseslabs.com.br")

SMTP = {
    "host": os.environ.get("SMTP_HOST", ""),
    "port": int(os.environ.get("SMTP_PORT", "465")),
    "user": os.environ.get("SMTP_USER", ""),
    "password": os.environ.get("SMTP_SENHA", ""),
}
PARA = os.environ.get("CONTATO_PARA", "")

EMAIL_RE = re.compile(r"^[^\s@<>()\"',;]{1,64}@[^\s@<>()\"',;]+\.[a-zA-Z]{2,}$")
LINK_RE = re.compile(r"https?://|www\.", re.I)

lock = threading.Lock()
usados = {}  # assinatura -> expira
por_ip = defaultdict(deque)


def assinar(*partes):
    return hmac.new(SECRET, "|".join(map(str, partes)).encode(), hashlib.sha256).hexdigest()


def novo_desafio():
    salt = secrets.token_hex(12)
    numero = secrets.randbelow(DIFICULDADE)
    desafio = hashlib.sha256(f"{salt}{numero}".encode()).hexdigest()
    emitido = int(time.time())
    return {
        "salt": salt,
        "desafio": desafio,
        "max": DIFICULDADE,
        "emitido": emitido,
        "assinatura": assinar(salt, desafio, emitido),
    }


def validar_prova(p):
    try:
        salt, desafio, emitido = str(p["salt"]), str(p["desafio"]), int(p["emitido"])
        numero, assinatura = int(p["numero"]), str(p["assinatura"])
    except (KeyError, TypeError, ValueError):
        return "prova inválida"
    agora = time.time()
    if not hmac.compare_digest(assinatura, assinar(salt, desafio, emitido)):
        return "prova inválida"
    if agora - emitido > VALIDADE:
        return "o formulário expirou; recarregue a página"
    if agora - emitido < TEMPO_MIN:
        return "rápido demais"
    if hashlib.sha256(f"{salt}{numero}".encode()).hexdigest() != desafio:
        return "prova inválida"
    with lock:
        for k in [k for k, exp in usados.items() if exp < agora]:
            del usados[k]
        if assinatura in usados:
            return "esta mensagem já foi enviada"
        usados[assinatura] = emitido + VALIDADE
    return None


def limite_ip(ip):
    agora = time.time()
    with lock:
        fila = por_ip[ip]
        while fila and agora - fila[0] > 3600:
            fila.popleft()
        if len(fila) >= POR_IP_HORA:
            return True
        fila.append(agora)
    return False


def gravar(registro):
    os.makedirs(DATA, exist_ok=True)
    with lock, open(os.path.join(DATA, "mensagens.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(registro, ensure_ascii=False) + "\n")


def enviar_email(r):
    if not (SMTP["host"] and SMTP["user"] and PARA):
        return
    msg = EmailMessage()
    msg["Subject"] = f"[Escribanote] Contato de {r['nome']}"
    msg["From"] = formataddr(("Site do Escribanote", SMTP["user"]))
    msg["To"] = PARA
    msg["Reply-To"] = formataddr((r["nome"], r["email"]))
    msg["Message-ID"] = make_msgid(domain=SMTP["user"].split("@")[-1])
    msg.set_content(
        f"{r['mensagem']}\n\n—\n{r['nome']} <{r['email']}>\n"
        f"Enviado pelo formulário de escribanote.meneseslabs.com.br em {r['quando']}.\n"
        "Responda este e-mail para falar direto com a pessoa."
    )
    try:
        ctx = ssl.create_default_context()
        if SMTP["port"] == 465:
            s = smtplib.SMTP_SSL(SMTP["host"], SMTP["port"], context=ctx, timeout=20, local_hostname=HELO)
        else:
            s = smtplib.SMTP(SMTP["host"], SMTP["port"], timeout=20, local_hostname=HELO)
            s.starttls(context=ctx)
        with s:
            s.login(SMTP["user"], SMTP["password"])
            s.send_message(msg)
        print(f"e-mail enviado ({r['id']})", flush=True)
    except Exception as e:  # a mensagem já está gravada; só registra a falha
        print(f"falha ao enviar e-mail ({r['id']}): {e.__class__.__name__}: {e}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "contato"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def responder(self, status, corpo):
        dados = json.dumps(corpo, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def ip(self):
        # Só o Caddy alcança este contêiner; o primeiro endereço do X-Forwarded-For é o do visitante.
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def do_GET(self):
        if self.path == "/api/contato/desafio":
            return self.responder(200, novo_desafio())
        if self.path == "/api/contato/saude":
            return self.responder(200, {"ok": True, "email": bool(SMTP["host"] and PARA)})
        self.responder(404, {"erro": "não encontrado"})

    def do_POST(self):
        if self.path != "/api/contato":
            return self.responder(404, {"erro": "não encontrado"})
        try:
            tamanho = int(self.headers.get("Content-Length", "0"))
            if not 0 < tamanho <= 20000:
                raise ValueError
            dados = json.loads(self.rfile.read(tamanho))
            if not isinstance(dados, dict):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            return self.responder(400, {"erro": "pedido inválido"})

        nome = str(dados.get("nome", "")).strip()
        email = str(dados.get("email", "")).strip()
        mensagem = str(dados.get("mensagem", "")).strip()

        # Campo-isca preenchido: finge sucesso para o robô não aprender nada.
        if str(dados.get("site", "")).strip():
            return self.responder(200, {"ok": True})

        if not 2 <= len(nome) <= 80:
            return self.responder(400, {"erro": "informe seu nome", "campo": "nome"})
        if len(email) > 120 or not EMAIL_RE.match(email):
            return self.responder(400, {"erro": "confira o seu e-mail", "campo": "email"})
        if not 10 <= len(mensagem) <= 4000:
            return self.responder(400, {"erro": "escreva a mensagem (de 10 a 4.000 caracteres)", "campo": "mensagem"})
        if len(LINK_RE.findall(mensagem)) > 2:
            return self.responder(400, {"erro": "a mensagem tem links demais", "campo": "mensagem"})
        # A prova só é conferida (e gasta) depois dos campos, para um erro de digitação não custar outra.
        erro = validar_prova(dados.get("prova") or {})
        if erro:
            return self.responder(400, {"erro": erro})
        if limite_ip(self.ip()):
            return self.responder(429, {"erro": "muitas mensagens seguidas; tente daqui a uma hora"})

        registro = {
            "id": secrets.token_hex(6),
            "quando": time.strftime("%Y-%m-%d %H:%M:%S %z"),
            "nome": nome,
            "email": email,
            "mensagem": mensagem,
            "ip": self.ip(),
            "navegador": (self.headers.get("User-Agent") or "")[:200],
        }
        gravar(registro)
        threading.Thread(target=enviar_email, args=(registro,), daemon=True).start()
        self.responder(200, {"ok": True})


if __name__ == "__main__":
    print(f"contato ouvindo em :8080 (e-mail {'ligado' if SMTP['host'] and PARA else 'desligado: só grava'})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
