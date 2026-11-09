# 03 · desktop 骨架：Go + mygo 起窗口

**阻塞**：01。

## 要做什么

`desktop/` 建一个 mygo 工程，起得来、画得出一个空窗口。这一张票**只证明技术路线成立**，不做业务。

## 为什么单独一张票

mygo 是本仓第一次引入的依赖（`github.com/egoist/mygo`，纯 Go 无 cgo，原生 UI 无 webview）。它能不能在本机一跑就通，是我没有一手证据的事。先用最小代价证实或推翻，别等到做完界面临门才发现不行。

## 内容

1. `desktop/go.mod`，引入 mygo。
2. `desktop/main.go`：一个窗口，标题写好，内容区放一行静态文字。
3. `desktop/Makefile` 或 `desktop/README.md` 里一条能跑的构建命令。
4. `.gitignore` 覆盖 `desktop/build/`。

## 验收

1. `cd desktop && go build ./...` 零错误。
2. `go run .` 能弹出窗口（我跑一次确认，截图留证）。
3. mygo 若在本机跑不起来，这张票转成「换方案」的讨论，不允许糊过去。

## 边界

不连后端。不做布局设计。窗口里除了标题和一行字什么都没有。
