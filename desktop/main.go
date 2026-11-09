// dsh-bot-crew 的桌面端：队伍对话。
package main

import (
	"log"
	"os"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	// 队伍地址与凭据来自环境：一个进程连一段对话，换段对话就换环境。
	base := os.Getenv("DSH_GW")
	if base == "" {
		base = "http://127.0.0.1:8788"
	}
	token := os.Getenv("DSH_TOKEN")

	s := &app{client: New(base, token)}
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:   "Bot 队伍",
			Width:   880,
			Height:  620,
			Content: ui.View(s.view),
		})
		s.refresh()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
