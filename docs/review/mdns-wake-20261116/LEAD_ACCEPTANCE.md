# mDNS 广播恢复验收

日期：2026-11-16（Asia/Shanghai）。实现成员为实际 OpenConsole `deepseek-v4.1-flash-500k`，lead 集成发布；没有 commit/push。

## 当前行为

- 自有 UDP socket 统一接收异步发送错误与同步 socket 异常；Bonjour 的 bind 错误也进入同一恢复路径，故障不穿透到进程。
- 广播失效时回收实例，按 1 秒起、封顶 30 秒的间隔重建；成功公告后清零退避。没有外部查询时也能从持续离线中恢复。
- 只有当前实例、当前记录实际公告成功才报告 ready；旧实例回调、普通应答和 TTL=0 撤公告不会点亮新记录。
- 停止取消恢复，关闭广播有等待上限，停止后 publish 不重开资源。队伍身份、端口、TXT 和配对协议保持。

## 实跑结果

- lead 的独立子进程探针通过：查询应答 EADDRNOTAVAIL、启动起持续离线再恢复、真实关闭 dgram socket 后的 ERR_SOCKET_DGRAM_NOT_RUNNING。三个场景均建立新 socket、恢复公告并正常停止；探针没有向局域网发送模拟公告。详见 `TRANSPORT_VERIFICATION.json`。
- 目标相关回归 111/111：discovery、index、headless-http、mobile-http 四个文件；类型检查与 release 构建通过，详见 `BUILD.json`。并行编译时曾有一次探针超过自身 12 秒时限，单独运行及最终三场景顺序运行通过；未放宽时限。
- 构建后通过既有 profile patch 重组加载。独立 superagent PID 12345、no-web，手机端口 43499，running/queued=0/0。热重载后管理端口 63886；discovery 的 ready 时间晚于本轮构建时间。`SERVICE_STATUS.json` 返回正常。
- 实际组播浏览发现 `dsh-crew-0kvcc5t`，端口 43499、公网入口 `https://crew.kentonnie.top`、P2P TXT 均在，详见 `LIVE_DISCOVERY.json`。
- 手机 sessions 接口未带配对凭据返回预期 401；主 GUI 64333 保留预期登录门槛 401。未重启主 GUI，未重配设备。
- 配对文件 SHA-256、3 台已配设备、79 条消息、62 条回复、28 张工单保持；详见 `DATA_BEFORE.json` 与 `RUNTIME_AFTER.json`。

## 备份与边界

- 受控集成前备份：`/Users/cpuser/.dsh/backups/botcrew-mdns-20261116-180558`，目录权限 0700，含运行候选包、profile、SQLite 一致性备份及配对文件。profile 仅追加发布注释。
- 当前无 USB 连接设备，本轮没有手机端实机重发，也没有强制整机睡眠。故障恢复由真实 Bonjour/multicast-dns 依赖和受控 UDP 故障验证，运行态再以真实组播发现及 HTTP 接口验证。
- 依赖私有 `server.mdns` 错误入口，升级 bonjour-service 时需复查；当前安装版本为 1.4.4。持续网络故障将持续显示错误并按上限重试。
- 成员曾在工作树临时 checkout 三个目标文件做早期对照，之后从备份恢复；最终入口保留原有无 Web inject 修改，其他既有 dirty 未触碰。后续对照改为隔离副本。
- 不声明全量套件通过。成员早期报告的全量失败未作为本轮验收依据；本轮目标相关验证以上述 111 项及真实传输探针为准。
