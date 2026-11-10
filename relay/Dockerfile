# 中转服务端在 NAS 上的部署。
#
# 极空间（ZSpace）的 Docker 版面板不认 compose 的 build 段，所以走「本机构建 → 传镜像」那条路：
#   docker build -t dsh-bot-crew-relay:0.1.0 .
#   docker save dsh-bot-crew-relay:0.1.0 | gzip > relay.tgz
#   scp relay.tgz nas:/tmp/
#   ssh nas 'docker load < /tmp/relay.tgz && docker compose -f relay.compose.yml up -d'
# 也支持在 NAS 上直接 build（它自带 BuildKit），见 docs/DEPLOY-NAS.md 的两条路。
#
# 多阶段：构建用完整 Node + 依赖，运行用 slim。运行镜像里只有 dist/ 与 node 本身 ——
# 没有 typescript、没有 vitest，也就是没有可以被利用的构建链。
FROM node:24-slim AS build
WORKDIR /app
# 只有 devDependencies（tsc）。先把清单拷进来再装，改了源码不会让这一层失效。
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile=false
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24-slim AS runtime
WORKDIR /app
# 只跑编译产物；服务端零运行时依赖，所以不需要 node_modules。
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production
# 容器里的监听地址必须是 0.0.0.0（Docker 的端口映射在容器外面），而防火墙在宿主那一层管。
ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=8787
EXPOSE 8787
# 非 root 跑：中转是公网暴露面，跑了就有一堆人在试探它。
USER node
# 健康检查打 /health（公开视图，不泄露谁的机器在线）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 直接 exec node：信号能送到进程，SIGTERM 才会走优雅退出那条路。
CMD ["node", "dist/main.js"]
