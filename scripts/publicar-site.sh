#!/usr/bin/env bash
# Publica o site e o app web no VPS. O app web importa as bibliotecas da extensão
# de /app/lib, que não ficam no repositório em site/: são copiadas de extension/src/lib.
# Uso: scripts/publicar-site.sh   (de qualquer pasta)
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -az --delete --exclude 'download/*.zip' --exclude 'app/lib/' site/ vps:/opt/escribanote/public/
rsync -az site/download/*.zip vps:/opt/escribanote/public/download/
rsync -az --delete extension/src/lib/ vps:/opt/escribanote/public/app/lib/
curl -fsS -o /dev/null https://escribanote.meneseslabs.com.br/app/lib/transcript.js && echo "site publicado (app/lib ok)"
