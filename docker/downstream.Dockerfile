FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY downstream/package.json downstream/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY downstream/tsconfig.json ./
COPY downstream/src ./src
USER node
CMD ["node_modules/.bin/tsx", "src/server.ts"]
