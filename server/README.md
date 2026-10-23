# Escribanote Pro — servidor

API da conta online do Escribanote: login por link mágico, reuniões sincronizadas com a extensão, busca,
IA inclusa com créditos, assinatura pela Stripe (cartão e Pix Automático) e links públicos de leitura.
O desenho completo está em [`../docs/TDD-escribanote-pro.md`](../docs/TDD-escribanote-pro.md).

- Node.js 24 + Fastify, Postgres 17. Dependências fixadas em `package.json`.
- Reaproveita as bibliotecas da extensão (`../extension/src/lib`): a ata, a busca e a página pública
  saem iguais às da extensão.
- O app web (`../site/app`) é estático e fala com esta API no mesmo endereço.

## Rotas

Todas em `/api/v1` (mais `/s/{token}` para os links públicos). Tabela completa no TDD, seção "APIs e
endpoints". Autenticação: cookie `rs` (app web, com o cabeçalho `X-Escribanote: 1` nas escritas) ou
`Authorization: Bearer` (extensão).

## Slack (opcional)

Crie o app uma vez em https://api.slack.com/apps › *Create New App* › *From a manifest*, colando
[`slack-app-manifest.json`](slack-app-manifest.json). Em *Basic Information* copie o Client ID, o
Client Secret e o Signing Secret para `pro.env`:

```
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

Sem essas variáveis as rotas `/api/v1/slack/*` respondem 503 e o app web esconde o painel do Slack.
Com elas, cada usuário Pro conecta o próprio workspace em Conta › Slack (OAuth), escolhe o canal das
atas e pode ligar "publicar sozinho". Perguntas no thread da ata chegam por `/api/v1/slack/events`
(assinatura conferida) e são respondidas pela IA com 1 crédito.

## Desenvolvimento e testes

```bash
docker run -d --name escribanote-pg-test -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=escribanote_test -p 127.0.0.1:55432:5432 postgres:17-alpine
npm install
npm test                                   # 38 testes contra Postgres real (IA e Stripe simuladas; SDKs reais checados pela rede)
node scripts/dev-server.js 8787            # API + site + app em http://127.0.0.1:8787/app/ (e-mail, IA e Stripe simulados)
CHROME=/caminho/do/chrome node test/e2e-web.mjs [pasta]              # área logada num Chrome real
CHROME=/caminho/do/chrome node ../extension/test/e2e-account.mjs     # extensão + app + API: conectar, sincronizar, IA da conta
```

`TEST_DATABASE_URL` troca o banco de teste (padrão `postgres://postgres:teste@127.0.0.1:55432/escribanote_test`).
Os testes apagam e recriam o esquema desse banco: nunca aponte para produção.

## Produção (VPS)

Stack em `/opt/escribanote` (arquivo [`../site/docker-compose.yml`](../site/docker-compose.yml)):

| Contêiner | Papel |
| --- | --- |
| `escribanote-site` | Site e app web estáticos (`./public`) |
| `escribanote-contato` | Formulário de contato (`/api/contato*`) |
| `escribanote-api` | Esta API (`/api/v1/*`, `/s/*`), build de `./src` |
| `escribanote-db` | Postgres 17, só na rede interna, dados em `./db` |
| `escribanote-backup` | `pg_dump` diário criptografado em `./backups`, guardado 14 dias |

Segredos (permissão 600, nunca no repositório): `pro.env` (API), `db.env` (senha do banco),
`backup.env` (senha do banco e dos backups), `contato.env` (formulário).

> **Guarde fora da VPS** uma cópia de `DATA_KEY` (pro.env) e de `BACKUP_PASSPHRASE` (backup.env).
> Sem `DATA_KEY` as reuniões no banco não podem ser lidas; sem `BACKUP_PASSPHRASE` os backups não abrem.

### Publicar uma versão

```bash
# da raiz do repositório
tar czf - server/package.json server/package-lock.json server/Dockerfile server/src server/scripts/stripe-setup.js extension/src/lib \
  | ssh VPS 'rm -rf /opt/escribanote/src/server /opt/escribanote/src/extension && tar xzf - -C /opt/escribanote/src'
(cd site && tar czf - app) | ssh VPS 'rm -rf /opt/escribanote/public/app && tar xzf - -C /opt/escribanote/public'
tar czf - -C extension/src lib | ssh VPS 'tar xzf - -C /opt/escribanote/public/app'
ssh VPS 'cd /opt/escribanote && docker compose build escribanote-api && docker compose up -d'
curl https://escribanote.meneseslabs.com.br/api/v1/health
```

As migrações (`src/migrations/*.sql`) rodam sozinhas quando a API sobe. Antes de uma migração,
faça um backup manual (abaixo).

### Stripe e Anthropic (uma vez)

1. Na Stripe (conta no Brasil), ative **Pix** e **cartão** em Configurações › Formas de pagamento.
2. Em Desenvolvedores › Chaves de API, copie a chave secreta (comece com a de teste, `sk_test_...`) para
   `STRIPE_SECRET_KEY` no `/opt/escribanote/pro.env`.
3. No console da Anthropic, crie uma chave só para o servidor, com limite de gasto mensal, e coloque em
   `ANTHROPIC_API_KEY`.
4. Rode o script que cria produto, preços (mensal R$ 15 e US$ 3, anual R$ 150 e US$ 30), webhook e portal, e grava os IDs no `pro.env`:

```bash
cd /opt/escribanote
docker compose run --rm --user root -v "$PWD/pro.env:/tmp/pro.env" escribanote-api node scripts/stripe-setup.js --write /tmp/pro.env
docker compose up -d escribanote-api
```

Para ir para produção, repita os passos 2 e 4 com a chave `sk_live_...`.

### Backups

```bash
# backup manual agora
docker exec escribanote-backup sh -c 'pg_dump -h escribanote-db -U escribanote -d escribanote --no-owner | gzip | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -out /backups/manual-$(date +%Y%m%d-%H%M).sql.gz.enc'
# restaurar num banco de teste (confira antes de restaurar em cima do banco real)
P=$(grep ^BACKUP_PASSPHRASE= backup.env | cut -d= -f2-)
docker exec escribanote-db createdb -U escribanote restaurado
BACKUP_PASSPHRASE="$P" openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in backups/ARQUIVO.sql.gz.enc | gunzip | docker exec -i escribanote-db psql -U escribanote -d restaurado
```

### Rollback

- A extensão funciona sem a API: derrubar a API não apaga nada dos computadores.
- Voltar a versão: publique o código anterior em `./src` e rode `docker compose build escribanote-api && docker compose up -d escribanote-api`.
- Pausar a IA inclusa sem derrubar o resto: esvazie `ANTHROPIC_API_KEY` e recrie a API (`docker compose up -d escribanote-api`).
- Pausar novas assinaturas: esvazie `STRIPE_PRICE_BRL` e `STRIPE_PRICE_USD` e recrie a API.

### Monitoramento

- `GET /api/v1/health` (banco e versão): cadastre no Uptime Kuma da VPS.
- Logs em JSON: `docker logs escribanote-api` (ou o Dozzle). Cookies e `Authorization` são omitidos.
- Custo de IA do dia: `docker exec escribanote-db psql -U escribanote -c "select sum(cost_usd) from ai_requests where created_at >= current_date"`.
