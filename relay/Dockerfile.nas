# 极空间 NAS 上的构建入口（不用 BuildKit 的多阶段）。
#
# 为什么单独一个文件：极空间宿主的 docker 26.1.4 跑在 5.8 内核上，BuildKit 的多阶段构建在这台机器上
# 不稳（前端那套同样内容的 Dockerfile 在这里会卡在第二个 stage）。所以这条路径是：
#   本机（Mac，Node 24）先 `pnpm build` 出 dist/，再把 dist/ + package.json 打进镜像。
# 镜像里没有 tsc、没有 vitest、没有源码 —— 构建链不在公网暴露面上。
#
# 用法（在 NAS 的 /tmp/zfsv3/nvme11/15916258010/data/Docker/crew-relay 下）：
#   docker build -f Dockerfile.nas -t dsh-bot-crew-relay:0.1.0 .
FROM node:22-slim
WORKDIR /app
COPY dist ./dist
COPY package.json ./
ENV NODE_ENV=production
ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=8787
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
