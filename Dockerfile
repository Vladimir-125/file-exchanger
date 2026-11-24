FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js schema.sql ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 3000
CMD ["node", "server.js"]
