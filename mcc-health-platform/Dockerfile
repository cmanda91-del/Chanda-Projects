FROM oven/bun:1.1.38
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
ENV NODE_ENV=production
CMD ["sh", "-c", "bun build-page.ts && bun server.ts"]
