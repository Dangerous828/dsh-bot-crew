// dsh-bot-crew 的桌面端：队伍对话。
package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// effectiveDeviceID 是真正会发出去的设备号：给了就用，没给就是 auth() 的默认值。
// 只用来在启动那一行里说清楚，不改变传入 Client 的取值。
func effectiveDeviceID(device string) string {
	if device == "" {
		return defaultDeviceID
	}
	return device
}

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

// defaultProfile 是没有 DSH_PROFILE 时用的那一个。
// 状态目录下可能有多个 profile（superagent / superagent-web …），只取这一个，不扫别的：
// 扫到哪个用哪个，等于让「连的是哪一段对话」由目录顺序决定。
const defaultProfile = "superagent"

// tokenFile 是某个 profile 的网关凭据落点。profile 名要做一层清洗：
// 带路径分隔符的话，拼出来就不是 state 目录里的那一份了。
func tokenFile(profile string) string {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		profile = defaultProfile
	}
	return filepath.Join(homeDir(), ".dsh", "state", profile, "mobilegw.token")
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// resolveToken 按优先级拿网关凭据：环境变量最高，其次是 profile 状态目录里的文件。
// 返回的 second 是凭据来自哪里（说明文字，或读失败时那个路径），用来在启动那一行里说清楚，
// 不打印凭据本身。
func resolveToken(readFile func(string) ([]byte, error)) (token string, source string) {
	if fromEnv := strings.TrimSpace(os.Getenv("DSH_TOKEN")); fromEnv != "" {
		return fromEnv, "环境变量 DSH_TOKEN"
	}
	profile := strings.TrimSpace(os.Getenv("DSH_PROFILE"))
	// 只认确认过的那一层：profile 名带上分隔符或 .. 就走不到 state 目录里面，
	// 那说明配置本身有问题，不拿拼接结果去猜一个近似目录。
	if profile != "" && (profile != filepath.Base(profile) || profile == "." || profile == "..") {
		return "", tokenFile("")
	}
	path := tokenFile(profile)
	raw, err := readFile(path)
	if err != nil {
		return "", path
	}
	token = strings.TrimSpace(string(raw))
	if token == "" {
		return "", path
	}
	return token, path
}

func main() {
	// 队伍地址与凭据来自环境：一个进程连一段对话，换段对话就换环境。
	base := os.Getenv("DSH_GW")
	if base == "" {
		base = "http://127.0.0.1:8788"
	}
	// 凭据按 环境变量 → profile 状态目录 的顺序取；设备号只认环境变量，没给由 auth() 兜默认值。
	token, source := resolveToken(os.ReadFile)
	device := strings.TrimSpace(os.Getenv("DSH_DEVICE"))
	if token == "" {
		// 拿不到就在启动时说一句：等到请求 401 才暴露，人会以为是后端坏了。
		// 只说路径，不猜内容 —— 凭据本身不进日志。
		log.Printf("没有找到网关凭据；把 token 放到 %s，或设 DSH_TOKEN。现在照常开窗，队伍连接会失败", source)
	} else {
		// 只说来源与设备号，不打印凭据。
		log.Printf("网关凭据来自 %s；设备号 %s", source, effectiveDeviceID(device))
	}

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
