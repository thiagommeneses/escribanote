# API do Reunilo Pro. Contexto do build: a raiz do repositório (usa as bibliotecas da extensão).
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /srv/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY server/scripts/stripe-setup.js ./scripts/stripe-setup.js
COPY extension/src/lib /srv/extension/src/lib
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1
CMD ["node", "src/index.js"]
