FROM node:24.13.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /opt/t3bot
COPY . .
RUN chmod +x apps/bot/executor-entrypoint.sh
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @t3tools/bot... --filter t3... --filter @t3tools/web...
RUN pnpm rebuild node-pty
RUN pnpm --filter @t3tools/web build && pnpm --filter t3 build:bundle
RUN mkdir -p /data/bot /data/t3 /workspace /home/node/.codex && chown -R node:node /data /workspace /home/node/.codex

FROM build AS bot
ARG COORDINATOR_PACKAGE=@openai/codex@0.163.0
RUN npm install --global "$COORDINATOR_PACKAGE"
USER node
ENV T3BOT_HOME=/data/bot T3BOT_HOST=0.0.0.0 T3BOT_PORT=3780
EXPOSE 3780
CMD ["node", "apps/bot/src/main.ts"]

FROM build AS executor
ARG WORKER_PACKAGE=@openai/codex@0.163.0
RUN npm install --global "$WORKER_PACKAGE"
USER node
ENV T3CODE_PORT=3773 T3CODE_HOST=0.0.0.0
EXPOSE 3773
ENTRYPOINT ["/opt/t3bot/apps/bot/executor-entrypoint.sh"]
