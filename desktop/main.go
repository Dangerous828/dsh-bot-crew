// dsh-bot-crew 的桌面端：队伍对话。
package main

import (
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

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
		client:     client,
		arrived:    make(chan *Conversation, 4),
		failed:     make(chan string, 4),
		sent:       make(chan string, 4),
		tree:       make(chan []AgentNode, 4),
		paired:     make(chan Credential, 4),
		pairFailed: make(chan string, 4),
		steps:      make(chan workResult, 4),
		// 模型那两条也在这里 make：忘掉一条，切模型就会永远停在「正在换…」。
		modelList:     make(chan *ModelCatalog, 4),
		modelSwitched: make(chan modelSwitchResult, 4),
		effortsCh:     make(chan *EffortsView, 4),
		modelError:    make(chan string, 4),
		retryErrorCh:  make(chan string, 4),
		screenNoteCh:  make(chan string, 4),
		screenCh:      make(chan *ScreenView, 4),
		withdrawn:     make(chan withdrawResult, 4),
		answered:      make(chan answerResult, 4),
		steerDone:     make(chan steerResult, 4),
		// 产出那两条也一样：不 make 的话，右栏会永远停在「正在读产出」。
		outputsCh: make(chan outputsResult, 4),
		ticketOut: make(chan ticketOutputsResult, 4),
		// perTicket 与 loadingTicket 按票建：结果条各记各的，同一张票一次只发一个请求。
		perTicket:     map[string]*OutputsView{},
		loadingTicket: map[string]bool{},

		// 代码卡上那两个按钮的结果：不 make 的话，按下去界面会永远停在「采用中…」。
		adopted:   make(chan adoptResult, 4),
		previewed: make(chan previewResult, 4),
		// 两张表按卡建：回执要落在自己的卡上，「采用中」与「已采用」也要各记各的。
		adopting:   map[string]bool{},
		adoptNotes: map[string]string{},
		adoptedOK:  map[string]bool{},

		pauseDone:     make(chan pauseResult, 2),
		botSaved:      make(chan botSaveResult, 2),
		devicesCh:     make(chan devicesResult, 4),
		revoking:      map[string]bool{},
		exportCh:      make(chan exportResult, 2),
		// 宽度先落在设计稿的两个值上；拖过之后只记在内存里。
		sidebarWidth: SidebarWidth,
		backendWidth: BackendWidth,
		// 打开窗口先看到「后台」那一栏，它是对外最早能看懂的一块。
		navTab:      navBackend,
		backendOpen: true,
		// 凭据已经在手上时直接说「已配对」：那块地方让给模型列表，不再占一整块。
		pairingNote: func() string {
			if client != nil && client.deviceID != "" && client.token != "" {
				return "已配对 · 这台已能直连"
			}
			return ""
		}(),
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

// resolved 是启动这次要连的一组值。
type resolved struct {
	Base   string
	Token  string
	Device string
	Target crewTarget
}

// locate 决定连哪一支队伍：环境变量 → 上次配好的凭据 → 自动发现 → 历史默认。
//
// 环境变量仍然最高，那是调试与特殊部署的后门；正常情况下这三样都由发现与配对提供。
func locate() resolved {
	base := strings.TrimSpace(os.Getenv("DSH_GW"))
	token := strings.TrimSpace(os.Getenv("DSH_TOKEN"))
	device := strings.TrimSpace(os.Getenv("DSH_DEVICE"))
	target := crewTarget{}
	if live := discover(profilesDir(), dialAlive); len(live) > 0 {
		target = live[0]
	}
	// 上次配对留下的凭据：它能补齐环境变量没给的任何一项。
	fromSaved := false
	if saved, ok := loadCredential(credentialPath()); ok {
		if base == "" {
			base = saved.Base
			fromSaved = true
		}
		if token == "" {
			token = saved.Token
		}
		if device == "" {
			device = saved.DeviceID
		}
	}
	// 保存的地址指向一个已经不在的端口（换了 profile、队伍没在跑）时，别抱着旧地址不放：
	// 发现到的活队伍才是能用的那一支。凭据属于旧队伍，一并清掉，让人重新配对。
	if fromSaved && target.Found && target.Base != "" && target.Base != base && !reachable(base) {
		log.Printf("保存的队伍 %s 已经连不上，改用发现的 %s；需要重新配对", base, target.Base)
		base, token, device = target.Base, "", ""
	}
	if base == "" {
		if target.Found {
			base = target.Base
		} else {
			base = "http://127.0.0.1:8788"
		}
	}
	// 旧的网关部署：token 落在 profile 的状态目录里。它只对网关端口有意义，
	// 设备凭据是另一套东西，不能拿去敲局域网那道门。
	if token == "" && base == "http://127.0.0.1:8788" {
		if legacy, source := resolveToken(os.ReadFile); legacy != "" {
			token = legacy
			log.Printf("网关凭据来自 %s", source)
		}
	}
	// 环境变量或上次配好的凭据指向本机另一支队伍时，配对也要打到那一支：
	// 否则按钮会去配一个窗口根本没在连的队伍，配完还是连不上。
	if pointed, ok := loopbackTarget(base); ok && pointed.Base != target.Base {
		target = pointed
	}
	return resolved{Base: base, Token: token, Device: device, Target: target}
}

// reachable 快速探一下 http://host:port 是否有监听。只探明文的本机/局域网地址：
// 公网 relay 不在这里探，一次启动多等一次网络超时不值得。
func reachable(base string) bool {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return true
	}
	connection, err := net.DialTimeout("tcp", parsed.Host, 400*time.Millisecond)
	if err != nil {
		return false
	}
	connection.Close()
	return true
}

// loopbackTarget 把 http://127.0.0.1:PORT 变成一个配对目标。
// 网页端口不在这里猜：配对时会按 lan 端口反查同一进程的监听。
func loopbackTarget(base string) (crewTarget, bool) {
	parsed, err := url.Parse(base)
	if err != nil {
		return crewTarget{}, false
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return crewTarget{}, false
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port <= 0 {
		return crewTarget{}, false
	}
	return crewTarget{Base: base, LanPort: port, Found: true}, true
}

func main() {
	located := locate()
	if located.Target.Found {
		log.Printf("发现队伍 %s：连 %s（设备号 %s）", located.Target.Profile, located.Base, effectiveDeviceID(located.Device))
	} else {
		log.Printf("没有发现正在跑的队伍；连 %s。右栏「配对手机」可以在队伍启动后自动配上", located.Base)
	}
	if located.Token == "" {
		log.Printf("还没有这台设备的凭据：窗口照常打开，配对后即可连接")
	}

	// 所有通道都要 make：nil 通道上的发送会永久阻塞，
	// 表现就是「数据早到了，界面却一直停在正在读…」。
	client := New(located.Base, located.Token, located.Device)
	// 设备表与备份在管理面上，而管理面是网页端口，不是消息面那个。发现到整支队伍时
	// 就把它指过去；只给了消息面地址（环境变量）时留空，那些按钮会如实报 404。
	if located.Target.WebPort > 0 {
		host := "127.0.0.1"
		if parsed, err := url.Parse(located.Base); err == nil && parsed.Hostname() != "" {
			host = parsed.Hostname()
		}
		client = client.WithManagement("http://" + net.JoinHostPort(host, strconv.Itoa(located.Target.WebPort)))
	}
	s := newApp(client)
	s.target = located.Target
	s.endpoint = located.Base
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
