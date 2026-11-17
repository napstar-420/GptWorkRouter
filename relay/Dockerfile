# GPTWorkRouter relay. Build context: this folder (relay/).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs pipe.mjs db.mjs admin.mjs ./
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
# ponytail: runs as root because Fly mounts the volume root-owned; drop to a user with a chown step if that matters.
CMD ["node", "server.mjs"]
