FROM node:24.22.1-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 12.11.1 ships prebuilt Node 24 glibc binaries, no toolchain needed
RUN npm ci --omit=dev

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Copy source
COPY src/ ./src/

# Copy static files (React SPA build output)
# build the frontend into web/public/ before building the image
COPY public/ ./public/

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 80 443 9000

# Run the server
CMD ["node", "src/index.js"]
