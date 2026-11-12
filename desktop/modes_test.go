package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 默认落聊天模式 + 事务板页签；navBoard 自己按下去也不重读、不收起。
func TestDefaultsAreChatModeWithBoardTab(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	if s.mode != modeChat {
		t.Fatalf("默认应是聊天模式，实际 %v", s.mode)
	}
	if s.navTab != navBoard || !s.backendOpen {
		t.Fatalf("默认右栏应是展开的事务板，实际 navTab=%v open=%v", s.navTab, s.backendOpen)
	}
	if modeName(modeChat) != "chat" || modeName(modeTriage) != "triage" || modeName(appMode(9)) != "unknown" {
		t.Fatal("模式名要说得出 chat / triage，认不出就说 unknown")
	}
	s.navTab = navOutput
	if !s.pressNav(navBoard) || s.navTab != navBoard || !s.backendOpen {
		t.Fatal("按事务板要切过去并展开")
	}
	if !s.pressNav(navBoard) || !s.backendOpen {
		t.Fatal("事务板不是开关，再按一次不该收起右栏")
	}
	if bus := newDebugBus(s); bus.navName(navBoard) != "board" || tabName(navBoard) != "board" {
		t.Fatal("调试总线的 navName / tabName 要认得事务板")
	}
}

// 点标题栏那条 segmented：只改 s.mode，不动别的状态，也不发一个请求。
func TestModeSwitchOnlyChangesModeAndSendsNothing(t *testing.T) {
	var requests int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		_, _ = w.Write([]byte(`{"items":[],"tasks":[]}`))
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "t", ""))
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 746)
	tt.Frame()
	// 首帧的右栏会读一次「已配对设备」快照（只读一次，见 ui.go 的 loadDevices），
	// 那是窗口自己的启动读取，与模式切换无关。等它落地取基线，再钉住「切模式不新增请求」。
	time.Sleep(80 * time.Millisecond)
	baseline := atomic.LoadInt32(&requests)
	before := s.navTab
	tt.Click("分拣台")
	tt.Frame()
	time.Sleep(80 * time.Millisecond)
	if s.mode != modeTriage {
		t.Fatalf("点「分拣台」应切到分拣台，实际 %v；画的是 %v", s.mode, tt.Texts())
	}
	if s.navTab != before || !s.backendOpen || s.input != "" {
		t.Fatal("切模式不该顺手改页签、收起右栏或动输入框")
	}
	if n := atomic.LoadInt32(&requests); n != baseline {
		t.Fatalf("切模式不该新增请求，基线 %d，现在 %d", baseline, n)
	}
	tt.Click("聊天")
	tt.Frame()
	time.Sleep(80 * time.Millisecond)
	if s.mode != modeChat {
		t.Fatalf("点「聊天」应切回来，实际 %v", s.mode)
	}
	if n := atomic.LoadInt32(&requests); n != baseline {
		t.Fatalf("来回切都不该新增请求，基线 %d，现在 %d", baseline, n)
	}
}

// 分拣台中栏：三段标题都在，底部计数带现算；没读到时间线时只说一句实话。
func TestTriagePaneShowsTheThreeSections(t *testing.T) {
	p := PaletteFor(false)
	s := &app{conversation: &Conversation{}}
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Width(718).FillHeight().Children(func() { s.triagePane(c, p) })
	}, 718, 600)
	tt.Frame()
	for _, want := range []string{"分拣台", "收件筐", "大哥在分", "各人的活儿", "收进 0 · 在跑 0 · 等你拍板 0 · 办完 0"} {
		if !tt.HasText(want) {
			t.Errorf("分拣台该出现 %q，画的是 %v", want, tt.Texts())
		}
	}

	s.conversation = nil
	tt = ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Width(718).FillHeight().Children(func() { s.triagePane(c, p) })
	}, 718, 600)
	tt.Frame()
	if !tt.HasText("正在读队伍的状态…") || tt.HasText("筐里还没有东西") {
		t.Fatalf("读不到时不该摆空纸条，画的是 %v", tt.Texts())
	}
}

// 调试总线按名字切模式，state.dump 读得回这份变化；坏名字明确报错。
func TestDebugBusSetsModeAndDumpsIt(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)
	if _, err := bus.invoke("mode.set", map[string]json.RawMessage{"mode": json.RawMessage(`"triage"`)}); err != nil {
		t.Fatalf("mode.set: %v", err)
	}
	if s.mode != modeTriage {
		t.Fatal("mode.set 没切过去")
	}
	dump, err := bus.invoke("state.dump", map[string]json.RawMessage{})
	if err != nil {
		t.Fatalf("state.dump: %v", err)
	}
	if got := dump.(map[string]any)["mode"]; got != "triage" {
		t.Fatalf("dump 的 mode 应是 triage，实际 %v", got)
	}
	if _, err := bus.invoke("mode.set", map[string]json.RawMessage{"mode": json.RawMessage(`"nope"`)}); err == nil {
		t.Fatal("认不出的模式名该报错")
	}
	if _, err := bus.invoke("nav.board", map[string]json.RawMessage{}); err != nil {
		t.Fatalf("nav.board: %v", err)
	}
	if s.navTab != navBoard {
		t.Fatal("nav.board 应切到事务板")
	}
}
