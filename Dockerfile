# GateCheck: one container serving the API and the built web app on one port.
# Native modules are installed once, in the build stage, which has the toolchain node-gyp
# needs. The runtime stage reuses that node_modules and never installs or compiles anything.

# ---- build: compile the web app and bundle the server -------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` runs node-gyp for better-sqlite3, and the slim image has no Python or compiler.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production dependencies only ------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/gatecheck.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config

# The entry log lives on a volume so it survives restarts and redeploys.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Secrets are passed as environment variables at run time. No .env file is baked into the image.
CMD ["node", "dist/server/index.js"]
