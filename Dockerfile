FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && npx --yes playwright@1.64.1 install --with-deps chromium \
 && npm prune --omit=dev \
 && mkdir -p /app/data \
 && chown -R node:node /app /ms-playwright

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data DIST_DIR=/app/dist
USER node
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "src/server/index.ts"]
