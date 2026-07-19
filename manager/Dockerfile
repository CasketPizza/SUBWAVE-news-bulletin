FROM node:22-alpine

RUN apk add --no-cache \
    bash curl ffmpeg git python3 docker-cli docker-cli-compose

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY public ./public

EXPOSE 7711
CMD ["node", "server.mjs"]
