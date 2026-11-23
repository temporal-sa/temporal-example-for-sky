# One image definition for the fulfilment Worker, the console API and the tests, so they share
# the same dependencies and Workflow code. Build context is the repo root.
FROM node:24.22.3-bookworm-slim AS deps
WORKDIR /app
COPY fulfilment/package.json fulfilment/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY fulfilment/tsconfig.json fulfilment/vitest.config.ts ./
COPY fulfilment/src ./src

FROM deps AS test
CMD ["sh", "-c", "node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run"]

FROM deps AS worker
USER node
CMD ["node_modules/.bin/tsx", "src/worker.ts"]

FROM node:24.22.3-bookworm-slim AS console-build
WORKDIR /console
COPY console/package.json console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY console/ ./
RUN npm run build

FROM deps AS api
COPY --from=console-build /console/dist /app/console
ENV CONSOLE_DIR=/app/console
USER node
CMD ["node_modules/.bin/tsx", "src/api.ts"]
