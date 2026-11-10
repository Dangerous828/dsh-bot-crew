// dsh-bot-crew 的桌面端：队伍对话。
package main

import (
	"log"
	"os"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// newApp 造一个接好线的 app。通道全在这里 make —— nil 通道上的发送会永久阻塞，
// 表现就是「数据早到了，界面却一直停在正在读…」。
func newApp(client *Client) *app {
	return &app{
		client:  client,
		arrived: make(chan *Conversation, 4),
		failed:  make(chan string, 4),
		tree:    make(chan []AgentNode, 4),
		paired:  make(chan string, 4),
		steps:   make(chan workResult, 4),
		// 模型那两条也在这里 make：忘掉一条，切模型就会永远停在「正在换…」。
		modelList:     make(chan *ModelCatalog, 4),
		modelSwitched: make(chan ModelChoice, 4),
		// 打开窗口先看到「后台」那一栏，它是对外最早能看懂的一块。
		navTab:      navBackend,
		backendOpen: true,
	}
}

func main() {
	// 队伍地址与凭据来自环境：一个进程连一段对话，换段对话就换环境。
	base := os.Getenv("DSH_GW")
	if base == "" {
		base = "http://127.0.0.1:8788"
	}
	token := os.Getenv("DSH_TOKEN")
	// 设备号与凭据是队伍签发的；留空表示走网关那套鉴权。
	device := os.Getenv("DSH_DEVICE")

	// 所有通道都要 make：nil 通道上的发送会永久阻塞，
	// 表现就是「数据早到了，界面却一直停在正在读…」。
	s := newApp(New(base, token, device))
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title: "Bot 队伍",
			// 画板是 1440×1160：左 329 + 中 718 + 右 393。窗口比这窄，
			// 中栏就被挤成一条，中文会一字一行地竖着排。
			Width:   1440,
			Height:  900,
			Content: ui.View(s.view),
		})
		s.refresh()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
