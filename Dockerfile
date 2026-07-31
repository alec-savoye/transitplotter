# Single image usable for server, web-dev, or the build-static script.
# The compose file selects which command to run.
FROM node:22-bookworm-slim

# better-sqlite3 needs a build toolchain for its native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm install

# Copy the rest of the monorepo.
COPY . .

# server (default). Overridden per-service in compose.
EXPOSE 8080 5173
CMD ["npm", "run", "dev:server"]
