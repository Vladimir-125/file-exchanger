FROM node:22-alpine AS deps
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server.ts"]
