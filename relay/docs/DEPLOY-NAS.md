# 把中转放到 NAS 上

目标：NAS（`192.168.31.152`，极空间 Z4，已有 Docker）跑一个 `crew-relay` 容器，宿主在外面
主动连它，手机从任何地方连它。

## 零、2026-11-10 实际部署记录（照这份做，不要再走 relay.kentonnie.top）

- **目录**：`/tmp/zfsv3/nvme11/15916258010/data/Jarvis/crew_relay/`
- **构建路线**：`Dockerfile.nas`（Mac 上 `npm run build` 出 `dist/`，与 `package.json` 一起打包，
  NAS `docker build -f Dockerfile.nas`）。NAS 上多阶段构建不稳，别用 `Dockerfile`。
- **宿主端口**：`192.168.31.152:18800`（容器内 8787；宿主 8787 被 devgame-act 占用）。
- **公网入口**：`relay.kentonnie.top` **已被 AI-HUB 的 `dsh-relay` 占用**，不要覆盖。本服务改走
  既有域名的子路径，不需要改 Cloudflare 面板：

  ```
  https://jarvis.kentonnie.top/crew-relay/health
  wss://jarvis.kentonnie.top/crew-relay/tunnel
  https://jarvis.kentonnie.top/crew-relay/i/<instanceId>/api/mobile/...
  ```

- **Caddy 段**（`jarvis-caddy`，插在 `http://jarvis.kentonnie.top` 的兜底 `handle {` 之前）：

  ```
  handle_path /crew-relay/* {
      reverse_proxy 192.168.31.152:18800 {
          flush_interval -1
      }
  }
  ```

  改完 `caddy validate` → `caddy reload`。备份在容器内
  `/etc/caddy/Caddyfile.bak-20261110-crewrelay`。
  限流按来源地址计数；这条链路是 Cloudflare → Caddy → relay，所以 relay 优先读
  `CF-Connecting-IP`（Caddy 会原样转过去）。如果换掉 Cloudflare，要确认反代把真实客户端地址
  追加到 `X-Forwarded-For` 的最右段，否则所有手机在中转眼里会是同一个来源。
- **宿主（Mac）**：配置放在仓库外的 `~/.config/crew-desktop/relay.env`（600），键名与 `relay/.env` 一致：

  ```sh
  CREW_RELAY_URLS=wss://jarvis.kentonnie.top/crew-relay/tunnel
  CREW_RELAY_SECRET=<relay/.env 里的 CREW_RELAY_SECRET>
  CREW_RELAY_INSTANCE=kenton-mac
  ```

  `backend/scripts/dsh-superagent start|restart` 会在启动 DSH 前载入这份文件，所以跑
  `./scripts/dsh-superagent restart --profile superagent` 即可连上中转。文件不存在时什么都不做。
  只有用 Electron/Finder 启动、不经过这个脚本时，才需要改走 `launchctl setenv` 再重启 Electron；
  两种方式的环境变量名相同，密钥必须与 `relay/.env` 一致。
- **验收（已实测）**：`/health?detail=1` 返回 `tunnels:1`、`instances:[{instanceId:"kenton-mac"}]`；
  `GET https://jarvis.kentonnie.top/crew-relay/i/kenton-mac/api/mobile/timeline` 带设备凭据返回 200。

手机把地址填成 `https://jarvis.kentonnie.top/crew-relay/i/kenton-mac` 即可在外网使用。

```
手机 ──https──► Cloudflare / Caddy ──http──► 192.168.31.152:18800 (crew-relay) ◄──wss── 宿主（任意网络）
```

中转自己**不做 TLS**，只监听回环。公网那一段交给已经在家里的 Cloudflare Tunnel 或 Caddy。
理由：证书轮换、HSTS、OCSP 这些事已经有现成的进程在管，再让中转自己去管一份证书，
只是多一个会过期的文件。

---

## 一、准备两个密钥

```sh
# 宿主注册时出示的。没有它，任何人知道你的 instanceId 就能抢注。
openssl rand -base64 32

# 健康检查的详细视图（列出谁的机器在线）。可以不给，那就没有详情。
openssl rand -base64 32
```

记下它们，下一步要写进 `.env`。

---

## 二、把镜像送上去

极空间的 Docker 面板对 compose 的 `build:` 只支持一部分，所以最稳的是**本机构建、传镜像**。

在你的 Mac 上：

```sh
cd ~/Code/dsh-bot-crew/relay

# 1. 构建。--platform linux/amd64：NAS 是 x86，Apple Silicon 编出来的是 arm64。
docker build --platform linux/amd64 -t dsh-bot-crew-relay:0.1.0 .

# 2. 导出并压缩（镜像约 200MB，压缩后一半左右）。
docker save dsh-bot-crew-relay:0.1.0 | gzip > /tmp/crew-relay-0.1.0.tgz

# 3. 传到 NAS。路径按你 NAS 上的实际共享目录改；下面用「个人空间/docker」举例。
scp /tmp/crew-relay-0.1.0.tgz nas:/opt/data/docker/crew-relay/
```

> 如果 `nas` 这个 ssh alias 没有配，按 `~/.home-agent-hub/HOSTS.md` 的说法用 `192.168.31.152`，
> 用户名按 NAS 上你实际用的那个。密钥在 `~/.ssh/id_ed25519`。

### 或者在 NAS 上直接构建

NAS 自带 BuildKit。把整个 `relay/` 目录传上去再 build，省掉 `docker save/load` 那一步：

```sh
rsync -a --exclude node_modules --exclude dist relay/ nas:/opt/data/docker/crew-relay/
ssh nas 'cd /opt/data/docker/crew-relay && docker build -t dsh-bot-crew-relay:0.1.0 .'
```

代价是每次改代码都要重传一遍源码、重装一次依赖。本机构建适合频繁迭代。

---

## 三、起容器

在 NAS 上，`relay/` 目录里的三个文件要放齐：`relay.compose.yml`、`Dockerfile`（只有走 build 才需要）、`.env`。

```sh
ssh nas
cd /opt/data/docker/crew-relay

cat > .env <<'EOF'
CREW_RELAY_SECRET=<第一步里的第一个密钥>
CREW_RELAY_ADMIN_TOKEN=<第一步里的第二个密钥>
EOF
chmod 600 .env

docker load < crew-relay-0.1.0.tgz
docker compose -f relay.compose.yml up -d
docker compose -f relay.compose.yml ps
```

看它是不是活着：

```sh
# 容器内自检
docker exec crew-relay node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(console.log)"

# 从宿主机（不是容器内）打一次：这一步过了，说明端口映射是对的
curl -s http://127.0.0.1:8787/health
# {"ok":true,"uptimeMs":1234,"tunnels":0}

curl -s -H "Authorization: Bearer $CREW_RELAY_ADMIN_TOKEN" "http://127.0.0.1:8787/health?detail=1"
# {"ok":true,...,"instances":[],"blocked":0}
```

`tunnels: 0` 是正常的 —— 还没有宿主连上来。

---

## 四、把公网那一段接上

> **先读这一条。** 以下是「独立域名 + 回环端口 8787」的通用变体。2026-11-10 的实际部署不是这个形状：
> `relay.kentonnie.top` 已被 AI-HUB 占用，本服务挂在 `https://jarvis.kentonnie.top/crew-relay/`
> 子路径下，宿主端口是 `18800`。照 §0 做；本节只在换一台没有域名冲突的机器时参考，
> 不要把它里面的 `relay.kentonnie.top { ... }` 直接贴到线上 Caddy。

两种现成的做法，选一个。

### A. Cloudflare Tunnel（家里已经有 cloudflared 的话）

在 Cloudflare 的 Tunnel 配置里加一条：

```
relay.kentonnie.top → http://127.0.0.1:8787
```

`cloudflared` 已经在家里的某台机器上跑着（新台式机的 `win-desktop-ssh` 那条）。它连的是
**本机**的回环，所以要么让 cloudflared 与 crew-relay 跑在同一台机器上，要么把这条 ingress
指到 NAS 的局域网地址（`http://192.168.31.152:8787`，那就得把那一条端口从回环放开，见下面的注意事项）。

WebSocket 是 Cloudflare Tunnel 原生支持的，不用额外配置。

### B. NAS 上已有的 Caddy

`jarvis-caddy` 管着公网入口。加一段：

```caddyfile
relay.kentonnie.top {
  reverse_proxy 127.0.0.1:8787
}
```

Caddy 默认就带 WebSocket 升级转发，也不需要额外配置。

改完 reload，**不要 `docker compose up -d caddy`** —— 那是 recreate，会把公网入口白中断几秒：

```sh
docker exec jarvis-caddy caddy reload --config /etc/caddy/Caddyfile
```

### 注意事项：把端口放开到局域网

上面两条都假设反代和中转在同一台机器上（走 `127.0.0.1`）。如果反代在别的机器上，
`relay.compose.yml` 的 `ports:` 要改成 `"192.168.31.152:8787:8787"` —— **只绑局域网地址，
绝不绑 `0.0.0.0`**。绑了就是明文 `ws://` 直接对着公网，手机的设备凭据会在链路上裸奔。

---

## 五、让宿主连上来

在宿主那边（跑 dsh 的那台机器）设三个环境变量，然后重启 dsh：

```sh
export CREW_RELAY_URLS="wss://relay.kentonnie.top/tunnel"
export CREW_RELAY_SECRET="<第一步里的第一个密钥>"
# 可选。不设就由状态目录算出来，同一个目录永远是同一个 id。
export CREW_RELAY_INSTANCE="kenton-mac"
```

`CREW_RELAY_URLS` 是逗号分隔的：**第一条是自建中转，后面的都是兜底**。见
`backend/src/app/relay-chain.ts` 的说明，以及下一节。

起来之后在 NAS 上看：

```sh
curl -s -H "Authorization: Bearer $CREW_RELAY_ADMIN_TOKEN" "http://127.0.0.1:8787/health?detail=1"
# {"instances":[{"instanceId":"kenton-mac","name":"...","connectedAt":...,"inflight":0}],...}
```

然后手机上把地址从 `http://192.168.31.127:<lanPort>` 换成 `https://relay.kentonnie.top/i/<instanceId>/`：
路径要带上 instanceId，因为一台中转要服务多台宿主机。

```
https://relay.kentonnie.top/i/kenton-mac/api/mobile/timeline
```

---

## 六、排障

| 症状 | 先看什么 |
| --- | --- |
| `/health` 打不开 | `docker compose logs --tail 50`；`ss -ltnp \| grep 8787` 看端口有没有真的绑上 |
| 宿主的日志里一直 `reconnecting` | 宿主那边 `CREW_RELAY_SECRET` 与 `.env` 里的不一样最常见；其次看 `wss://` 有没有被反代降成 `http` |
| `tunnels` 一直是 0 但宿主说 `live` | 多半是反代没转发 `Upgrade` 头；Cloudflare 与 Caddy 默认都转，自己写的 nginx 要显式配 |
| 手机 404 `Unknown instance` | `instanceId` 与宿主上那个不一样（`CREW_RELAY_INSTANCE` 或状态目录变了） |
| 手机 502 | 隧道通着但宿主那边的处理器出错了 —— 去宿主日志里看 |
| `health?detail=1` 报 `blocked` 不为 0 | 某个地址的凭据连续错很多次被封了 60s。看 `docker compose logs` 里的 `address blocked` |

---

## 七、升级与回滚

```sh
# 本机
cd ~/Code/dsh-bot-crew/relay
docker build --platform linux/amd64 -t dsh-bot-crew-relay:0.1.1 .
docker save dsh-bot-crew-relay:0.1.1 | gzip > /tmp/crew-relay-0.1.1.tgz
scp /tmp/crew-relay-0.1.1.tgz nas:/opt/data/docker/crew-relay/

# NAS
cd /opt/data/docker/crew-relay
docker load < crew-relay-0.1.1.tgz
sed -i 's/dsh-bot-crew-relay:0.1.0/dsh-bot-crew-relay:0.1.1/' relay.compose.yml
docker compose -f relay.compose.yml up -d
```

回滚就是把版本号改回去再来一次 `up -d`。旧镜像还在（`docker images`），`docker load` 也不用重跑。

**升级期间在途的请求会断**：`up -d` 会重建容器。宿主的退避重连让它几秒内自己连回来，
手机的请求那几秒会失败。要避免这一点得做滚动发布（两个容器 + 反代负载均衡），
为一个自用中转不值得 —— 但要知道这条代价。

重启宿主那边的 dsh 才能让它读到改了的环境变量。

---

## 八、备份

中转**不存任何东西**：没有数据库、没有磁盘卷、没有会话。所有状态都在内存里，重启即清空。
所以：

- 备份的对象只有 `.env`（两个密钥）。丢了它，宿主就连不上，得两边一起改。
- 不需要数据卷，不需要 `docker commit`，不需要考虑状态迁移。
