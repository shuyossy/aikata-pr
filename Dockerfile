# ---- Build stage ----
FROM node:22-slim AS builder
WORKDIR /opt/aikata-pr
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:cli

# ---- Runtime stage ----
FROM node:22-slim
# ローカルgit diff取得に必要
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/aikata-pr
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /opt/aikata-pr/dist ./dist
# aikata-pr コマンドとしてグローバルにリンク
RUN chmod +x dist/index.js && ln -s /opt/aikata-pr/dist/index.js /usr/local/bin/aikata-pr
EXPOSE 3000
# CMD を使用（独自 ENTRYPOINT を持つベースイメージに切り替えた際、
# /entrypoint.sh が exec "$@" で CMD を実行するパターンに対応）
CMD ["aikata-pr"]
