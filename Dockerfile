FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
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
CMD ["node", "dist/server/index.js"]
