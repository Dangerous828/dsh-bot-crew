# Android OTA

## 手机使用

首次启用：在手机打开 <https://crew.kentonnie.top/updates/android/latest.apk>，下载后按系统提示覆盖安装。包名和签名保持，沿用现有配对与应用数据，不卸载应用。

以后在 App 侧栏「工具 → 检查更新」检查、下载并安装。未配对时，配对屏也有「检查更新」。下载支持取消、进程重启后的续传；安装前核对长度、SHA-256、包名、版本与当前应用签名。需要时进入系统的「安装未知应用」设置，回到 App 后点「安装」，由系统确认。

## 发布

在仓库根目录运行：

```bash
./scripts/android-ota-release --version-name 0.2.0 --notes '本次更新说明'
```

命令读取已发布清单并递增 versionCode，构建 release APK、同签校验，先落地不可变 APK，再原子更新 manifest。不需要连接手机，也不手工修改 Gradle 的版本号。相同或更低的 versionCode 会被拦住，已有不可变包保留，正在下载的客户端继续使用其固定地址。

```bash
# 仅准备验证包，不改变线上清单
./scripts/android-ota-release --version-name 0.2.0-preview --prepare-only
```

预备版本也要高于已发布版本；已有线上版本后，省略 `--version-code` 自动取下一号。构建 ID 及版本名最多 64 字符，说明最多 2000 字符，APK 上限 256MiB。并发发布由文件锁排他。

发布默认使用当前独立 superagent 状态目录和 `https://crew.kentonnie.top`；其他明确部署可用 `--state-dir`、`--public-base` 指定。清单中的客户端启动指纹按状态目录计算。

## 分发与签名

- 首装入口：<https://crew.kentonnie.top/updates/android/latest.apk>
- 清单：<https://crew.kentonnie.top/updates/android/manifest.json>，每次现读。
- 不可变 APK：`/updates/android/<versionCode>/<sha256>.apk`，支持 GET、HEAD、单区间 Range。
- 本地目录：`<stateDir>/android-updates`。只有这片更新区域公开；手机 API 继续校验配对凭据。
- APK 构建时强制清空内置设备凭据和 gateway token，更新网络请求也不携带配对凭据。
- 发布钥匙固定在 `~/.config/botcrew-ota/`，目录 0700、钥匙和配置 0600，证书与现有安装相同。首次初始化仅接受当前已安装身份对应的已有 Android 钥匙，不生成不同的钥匙。迁移构建机器时一并迁移此私有目录，不提交进仓库。

当前版本的公开证书 SHA-256：`ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`。

## 维护

修改手机代码后只需运行发布命令；更新 APK 文件不需要重启后台。修改分发端代码时，先构建 backend，再触发既有 profile 的重组加载，保留 no-web 模式。公网隧道继续指向现有手机监听 43499，不新增服务器或端口。

App 内置的更新入口由 Gradle `crewUpdateUrl` 注入，发布命令按公网 origin 写入。现有安装首次接入本流程需要网页安装一次；之后在 App 内完成，系统安装确认仍由用户操作。
