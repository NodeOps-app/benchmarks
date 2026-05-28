FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
RUN npm run --silent bundle:burst-100k

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/burst-100k.cjs /app/coordinator.cjs

CMD ["node", "/app/coordinator.cjs"]
