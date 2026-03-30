# ---- Build stage ----
FROM node:22-slim AS builder
WORKDIR /opt/aikata-pr
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:cli

# ---- Runtime stage ----
FROM node:22-slim
WORKDIR /opt/aikata-pr
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /opt/aikata-pr/dist ./dist
# aikata-pr コマンドとしてグローバルにリンク
RUN chmod +x dist/index.js && ln -s /opt/aikata-pr/dist/index.js /usr/local/bin/aikata-pr
# CMD を使用（独自 ENTRYPOINT を持つベースイメージに切り替えた際、
# /entrypoint.sh が exec "$@" で CMD を実行するパターンに対応）
CMD ["aikata-pr"]
