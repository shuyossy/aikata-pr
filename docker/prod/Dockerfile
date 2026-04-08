FROM node:22-alpine

# gitコマンドが必要（リポジトリクローン用）
RUN apk add --no-cache git

WORKDIR /app

COPY dist/server.js ./
COPY dist/server.js.map ./
COPY node_modules/ ./node_modules/

EXPOSE 3000

CMD ["node", "server.js"]
