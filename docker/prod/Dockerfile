# --- builder: dist/server.js を生成 ---
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json build.ts ./
COPY src ./src

RUN npm run build:cli

# --- deps: 本番用 node_modules のみ ---
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:22-alpine

# gitコマンドが必要（リポジトリクローン用）
RUN apk add --no-cache git

WORKDIR /app

# dist/server.js はESMバンドルのため、"type": "module" を効かせる目的で package.json が必須
COPY package.json ./
COPY --from=builder /app/dist/server.js ./
COPY --from=builder /app/dist/server.js.map ./
COPY --from=deps /app/node_modules ./node_modules/

EXPOSE 3000

CMD ["node", "server.js"]
