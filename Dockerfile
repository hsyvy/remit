# Remit as one long-running container. SQLite lives on a mounted volume at /var/data.
FROM node:22-slim

WORKDIR /app

# tsx runs the TypeScript directly, so dev dependencies are needed at runtime.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV PORT=3000 \
    REMIT_DB=/var/data/remit.db
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["npm", "start"]
