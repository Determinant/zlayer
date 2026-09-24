FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages ./packages
COPY tsconfig*.json ./
RUN npm ci
COPY src ./src
COPY tools/weather-server ./tools/weather-server
RUN npm run weather:build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY --from=build /build/tools/weather-server/dist ./tools/weather-server/dist
RUN mkdir -p /var/lib/weather && chown node:node /var/lib/weather
USER node
ENV NODE_ENV=production WEATHER_HOST=0.0.0.0 WEATHER_CACHE_DIR=/var/lib/weather
EXPOSE 8787
VOLUME /var/lib/weather
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEATHER_PORT||8787)+'/api/weather/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "tools/weather-server/dist/main.js"]
