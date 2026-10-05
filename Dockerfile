FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3007 \
    DATABASE_PATH=/app/data/request-bin.sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The database and log files are written here; mount volumes to keep them
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
USER node

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/app.js"]
