FROM node:22-bookworm-slim AS base

WORKDIR /app

# lsblk などのディスク管理ツールをインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    util-linux \
    udev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# ------- テスト -------
FROM base AS test
CMD ["npm", "test"]

# ------- 本番ビルド & 起動 -------
FROM base AS production
RUN npm run build
EXPOSE 3000

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/config/defaults', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/server/index.js"]
