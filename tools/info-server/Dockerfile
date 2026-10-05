FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages ./packages
COPY tools/info-server/vendor ./tools/info-server/vendor
COPY tsconfig*.json ./
RUN npm ci
COPY src ./src
COPY tools/info-server ./tools/info-server
COPY tools/check-info-api.ts ./tools/check-info-api.ts
RUN npm run info:build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY --from=build /build/tools/info-server/dist ./tools/info-server/dist
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/weather /var/lib/notams && chown node:node /var/lib/weather /var/lib/notams
USER node
ENV NODE_ENV=production INFO_HOST=0.0.0.0 WEATHER_CACHE_DIR=/var/lib/weather NOTAMS_STATE_DIR=/var/lib/notams
EXPOSE 8787
VOLUME /var/lib/weather /var/lib/notams
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.INFO_PORT||8787)+'/api/weather/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "tools/info-server/dist/main.js"]
