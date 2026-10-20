# Reunilo Pro — servidor

API da conta online do Reunilo: login por link mágico, reuniões sincronizadas com a extensão, busca,
IA inclusa com créditos, assinatura pela Stripe (cartão e Pix Automático) e links públicos de leitura.
O desenho completo está em [`../docs/TDD-reunilo-pro.md`](../docs/TDD-reunilo-pro.md).

- Node.js 24 + Fastify, Postgres 17. Dependências fixadas em `package.json`.
- Reaproveita as bibliotecas da extensão (`../extension/src/lib`): a ata, a busca e a página pública
  saem iguais às da extensão.
- O app web (`../site/app`) é estático e fala com esta API no mesmo endereço.

## Rotas

Todas em `/api/v1` (mais `/s/{token}` para os links públicos). Tabela completa no TDD, seção "APIs e
endpoints". Autenticação: cookie `rs` (app web, com o cabeçalho `X-Reunilo: 1` nas escritas) ou
`Authorization: Bearer` (extensão).

## Desenvolvimento e testes

```bash
docker run -d --name reunilo-pg-test -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=reunilo_test -p 127.0.0.1:55432:5432 postgres:17-alpine
npm install
npm test                                   # 35 testes contra Postgres real (IA e Stripe simuladas; SDKs reais checados pela rede)
node scripts/dev-server.js 8787            # API + site + app em http://127.0.0.1:8787/app/ (e-mail, IA e Stripe simulados)
CHROME=/caminho/do/chrome node test/e2e-web.mjs [pasta]              # área logada num Chrome real
CHROME=/caminho/do/chrome node ../extension/test/e2e-account.mjs     # extensão + app + API: conectar, sincronizar, IA da conta
```

`TEST_DATABASE_URL` troca o banco de teste (padrão `postgres://postgres:teste@127.0.0.1:55432/reunilo_test`).
Os testes apagam e recriam o esquema desse banco: nunca aponte para produção.

## Produção (VPS)

Stack em `/opt/reunilo` (arquivo [`../site/docker-compose.yml`](../site/docker-compose.yml)):

| Contêiner | Papel |
| --- | --- |
| `reunilo-site` | Site e app web estáticos (`./public`) |
| `reunilo-contato` | Formulário de contato (`/api/contato*`) |
| `reunilo-api` | Esta API (`/api/v1/*`, `/s/*`), build de `./src` |
| `reunilo-db` | Postgres 17, só na rede interna, dados em `./db` |
| `reunilo-backup` | `pg_dump` diário criptografado em `./backups`, guardado 14 dias |

Segredos (permissão 600, nunca no repositório): `pro.env` (API), `db.env` (senha do banco),
`backup.env` (senha do banco e dos backups), `contato.env` (formulário).

> **Guarde fora da VPS** uma cópia de `DATA_KEY` (pro.env) e de `BACKUP_PASSPHRASE` (backup.env).
> Sem `DATA_KEY` as reuniões no banco não podem ser lidas; sem `BACKUP_PASSPHRASE` os backups não abrem.

### Publicar uma versão

```bash
# da raiz do repositório
tar czf - server/package.json server/package-lock.json server/Dockerfile server/src server/scripts/stripe-setup.js extension/src/lib \
  | ssh VPS 'rm -rf /opt/reunilo/src/server /opt/reunilo/src/extension && tar xzf - -C /opt/reunilo/src'
(cd site && tar czf - app) | ssh VPS 'rm -rf /opt/reunilo/public/app && tar xzf - -C /opt/reunilo/public'
tar czf - -C extension/src lib | ssh VPS 'tar xzf - -C /opt/reunilo/public/app'
ssh VPS 'cd /opt/reunilo && docker compose build reunilo-api && docker compose up -d'
curl https://reunilo.meneseslabs.com.br/api/v1/health
```

As migrações (`src/migrations/*.sql`) rodam sozinhas quando a API sobe. Antes de uma migração,
faça um backup manual (abaixo).

### Stripe e Anthropic (uma vez)

1. Na Stripe (conta no Brasil), ative **Pix** e **cartão** em Configurações › Formas de pagamento.
2. Em Desenvolvedores › Chaves de API, copie a chave secreta (comece com a de teste, `sk_test_...`) para
   `STRIPE_SECRET_KEY` no `/opt/reunilo/pro.env`.
3. No console da Anthropic, crie uma chave só para o servidor, com limite de gasto mensal, e coloque em
   `ANTHROPIC_API_KEY`.
4. Rode o script que cria produto, preços (R$ 15 e US$ 3), webhook e portal, e grava os IDs no `pro.env`:

```bash
cd /opt/reunilo
docker compose run --rm --user root -v "$PWD/pro.env:/tmp/pro.env" reunilo-api node scripts/stripe-setup.js --write /tmp/pro.env
docker compose up -d reunilo-api
```

Para ir para produção, repita os passos 2 e 4 com a chave `sk_live_...`.

### Backups

```bash
# backup manual agora
docker exec reunilo-backup sh -c 'pg_dump -h reunilo-db -U reunilo -d reunilo --no-owner | gzip | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -out /backups/manual-$(date +%Y%m%d-%H%M).sql.gz.enc'
# restaurar num banco de teste (confira antes de restaurar em cima do banco real)
P=$(grep ^BACKUP_PASSPHRASE= backup.env | cut -d= -f2-)
docker exec reunilo-db createdb -U reunilo restaurado
BACKUP_PASSPHRASE="$P" openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in backups/ARQUIVO.sql.gz.enc | gunzip | docker exec -i reunilo-db psql -U reunilo -d restaurado
```

### Rollback

- A extensão funciona sem a API: derrubar a API não apaga nada dos computadores.
- Voltar a versão: publique o código anterior em `./src` e rode `docker compose build reunilo-api && docker compose up -d reunilo-api`.
- Pausar a IA inclusa sem derrubar o resto: esvazie `ANTHROPIC_API_KEY` e recrie a API (`docker compose up -d reunilo-api`).
- Pausar novas assinaturas: esvazie `STRIPE_PRICE_BRL` e `STRIPE_PRICE_USD` e recrie a API.

### Monitoramento

- `GET /api/v1/health` (banco e versão): cadastre no Uptime Kuma da VPS.
- Logs em JSON: `docker logs reunilo-api` (ou o Dozzle). Cookies e `Authorization` são omitidos.
- Custo de IA do dia: `docker exec reunilo-db psql -U reunilo -c "select sum(cost_usd) from ai_requests where created_at >= current_date"`.
