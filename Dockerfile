# StockSync 컨테이너 이미지 (Traefik 등 Docker 기반 프록시 뒤에서 실행할 때 사용)
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY migrations ./migrations
COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY views ./views
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/data/stocksync.db SECURE_COOKIE=1 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
