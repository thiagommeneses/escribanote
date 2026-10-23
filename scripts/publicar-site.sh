#!/usr/bin/env bash
# Publica o site e o app web no VPS. O app web importa as bibliotecas da extensão
# de /app/lib, que não ficam no repositório em site/: são copiadas de extension/src/lib.
# Os imports do app e a tag <script> recebem ?v=<versão da extensão>, para que o navegador
# nunca misture um app.js novo com um lib/ antigo em cache.
# Uso: scripts/publicar-site.sh   (de qualquer pasta)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude 'download/*.zip' --exclude 'app/lib/' site/ "$STAGE/"
sed -i -E "s#(from \"\./(lib/)?[a-z-]+\.js)\"#\1?v=$VERSION\"#g" "$STAGE/app/app.js" "$STAGE/app/api.js"
sed -i -E "s#src=\"app\.js\"#src=\"app.js?v=$VERSION\"#; s#href=\"app\.css\"#href=\"app.css?v=$VERSION\"#" "$STAGE/app/index.html"
grep -q "app.js?v=$VERSION" "$STAGE/app/index.html"
rsync -az --delete --exclude 'download/*.zip' --exclude 'app/lib/' "$STAGE/" vps:/opt/escribanote/public/
rsync -az site/download/*.zip vps:/opt/escribanote/public/download/
rsync -az --delete extension/src/lib/ vps:/opt/escribanote/public/app/lib/
curl -fsS -o /dev/null https://escribanote.meneseslabs.com.br/app/lib/transcript.js && echo "site publicado (app/lib ok, v=$VERSION)"
