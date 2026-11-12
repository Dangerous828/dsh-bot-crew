# tailcat 原生这一层

手机走 P2P 的两个文件：

| 文件 | 来源 | 说明 |
|---|---|---|
| `../jniLibs/arm64-v8a/libtailcat.so` | `backend/scripts/build-tailcat-android` | 隧道本体（Go 编出来的 C 共享库），只带 arm64-v8a，约 16MB，不入库 |
| `tailcat_jni.c` + `CMakeLists.txt` | 本目录 | JNI 包装，每个 ABI 都编 |

ABI 这件事：真机是 arm64-v8a，所以只带了这一份 `libtailcat.so`。模拟器是 x86_64，
那里包装库能装、能加载，但要建隧道时找不到 `libtailcat.so`，于是 `TailcatNative.unavailable`
非空，上层按「这台机器没有 P2P」退回局域网/公网 —— 其余功能一点不受影响。

要补别的 ABI：用同一个构建脚本交叉编出对应架构的 `libtailcat.so`，放进
`../jniLibs/<abi>/`，再在 `jniLibs/.gitignore` 里加一条，并用 `cpp/tailcat_abi.h` 对一遍 ABI 版本。

新机器上第一次编（`libtailcat.so` 不在版本库里）：

```bash
cd backend && ./scripts/build-tailcat-android
```

包装库用 `dlopen` 找符号而不是链接期依赖 `libtailcat.so`，就是为了让缺库的架构也能装上。

改完这两处之后：

```bash
cd app && ./gradlew assembleDebug
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -E 'libtailcat'
```
