package main

// session_gui_test.go —— 桌面端切会话的**整条链路**（issue #14 第 2 项「桌面 GUI 切会话同理补一遍」）。
//
// 为什么这一半要单独立一个文件：手机端那半是「经两道门各切一次会话、发一条、确认落对会话」，
// 桌面端没有等价的两道门（桌面只走消息面一条），也没有可点的外部动作 —— 调试口
// （desktop/debug.go 的 bus.register 列表）里**没有任何 session.* 动作**，所以切会话
// 在自动化眼里不是「按名字调一个动作」，只能走界面里那一条真实路径：
//
//	左栏会话列表（sessionPane）→ switchSession → Client.WithSession → 下一次请求带 session_id
//
// 这个文件就沿着这条路走一遍，五件事逐条钉住：
//  1. 列会话：GET /api/mobile/sessions 拿到 ["main","work"]，左栏真画出来；
//  2. 新建会话：点「新建」发 POST /api/mobile/sessions，成功后就切到新会话；
//  3. 切换：点左栏那一段之后，后续请求带 ?session_id= 且 x-crew-session 同值；
//  4. 发消息：切过去之后点「↑」，这一句落到切过去的那段会话，不落 main；
//  5. 缓存互不串：两段会话各自的时间线、消息条数各归各的，切走再切回不互相顶掉。
//
// 假后端是**真的 HTTP 服务**（httptest 起在回环上），Client 发的是真的请求、真的头，
// 只有「队伍那一侧」是假的。桌面端不碰真队列，是因为往真队列里发一句话会真的派活。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// guiBackend 是这组用例的假队伍：会话名单可增、每段会话各有一份自己的时间线。
type guiBackend struct {
	mu       sync.Mutex
	sessions []string
	items    map[string][]map[string]any // 会话 → 这条时间线里的消息
}

func newGUIBackend() *guiBackend {
	return &guiBackend{
		sessions: []string{"main", "work"},
		items: map[string][]map[string]any{
			"main": {
				{"id": "m1", "role": "user", "text": "主线第一句", "at": "2026-11-14T09:00:00+08:00"},
				{"id": "r1", "role": "agent", "text": "主线答一句", "at": "2026-11-14T09:00:05+08:00"},
			},
			"work": {
				{"id": "w1", "role": "user", "text": "工作线第一句", "at": "2026-11-14T09:05:00+08:00"},
			},
		},
	}
}

func (b *guiBackend) listed() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.sessions...)
}

func (b *guiBackend) add(id string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, listed := range b.sessions {
		if listed == id {
			return append([]string(nil), b.sessions...)
		}
	}
	b.sessions = append(b.sessions, id)
	if b.items[id] == nil {
		b.items[id] = []map[string]any{}
	}
	return append([]string(nil), b.sessions...)
}

// send 是一句真的落进某段会话的消息：消息进那段会话的时间线，和真后端一样。
func (b *guiBackend) send(session, text string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.items[session] = append(b.items[session], map[string]any{
		"id": "u-" + session, "role": "user", "text": text, "at": "2026-11-14T10:00:00+08:00",
	})
}

func (b *guiBackend) timeline(session string) []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]map[string]any(nil), b.items[session]...)
}

// sessionOf 与真后端同一套判定：query 优先、header 兜底、都没有就是 main。
func sessionOfRequest(r *http.Request) string {
	if asked := r.URL.Query().Get("session_id"); asked != "" {
		return asked
	}
	if header := r.Header.Get(sessionHeader); header != "" {
		return header
	}
	return defaultSessionID
}

// recordWith 记一次调用。sessionLog.record 会把 body 读走，handler 之后就看不到它了，
// 所以这里由调用方先读出 body 再记。
func (l *sessionLog) recordWith(r *http.Request, body string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, sessionCall{method: r.Method, url: r.URL.String(), body: body, headers: r.Header.Clone()})
}

// guiFixture 起一个真的 HTTP 假队伍，并把它接成桌面端的 Client。
func guiFixture(t *testing.T) (*guiBackend, *sessionLog, *app) {
	t.Helper()
	backend := newGUIBackend()
	log := &sessionLog{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r)
		log.recordWith(r, body)
		switch {
		case r.URL.Path == "/api/mobile/sessions" && r.Method == http.MethodGet:
			writeSessions(w, backend.listed(), "")
		case r.URL.Path == "/api/mobile/sessions" && r.Method == http.MethodPost:
			var asked struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal([]byte(body), &asked)
			writeSessions(w, backend.add(asked.ID), asked.ID)
		case r.URL.Path == "/api/mobile/timeline":
			session := sessionOfRequest(r)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": backend.timeline(session), "bots": []any{}, "tasks": []any{},
				"session_id": session, "session_api": sessionAPIBit,
				"sessions": backend.listed(), "default_session_id": defaultSessionID,
			})
		case r.URL.Path == "/api/mobile/send":
			session := sessionOfRequest(r)
			var asked struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal([]byte(body), &asked)
			backend.send(session, asked.Text)
			_, _ = w.Write([]byte(`{"ok":true,"id":1,"request_id":"rid"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	return backend, log, s
}

func writeSessions(w http.ResponseWriter, sessions []string, created string) {
	payload := map[string]any{"sessions": sessions, "default_session_id": defaultSessionID, "session_api": sessionAPIBit}
	if created != "" {
		payload["id"] = created
	}
	_ = json.NewEncoder(w).Encode(payload)
}

// sessionGUI 把整扇窗画出来（左栏会话列表、中栏对话、底部输入框都在里面）。
func sessionGUI(s *app) *ui.Tester {
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1440, 900)
	tt.Frame()
	return tt
}

// callsMatching 挑出 URL 命中某个片段的请求。
func callsMatching(log *sessionLog, needle string) []sessionCall {
	var found []sessionCall
	for _, call := range log.all() {
		if strings.Contains(call.url, needle) {
			found = append(found, call)
		}
	}
	return found
}

// 一条链路走到底：列 → 切 → 发 → 切回 → 新建 → 再切。每一步都看真发出去的请求。
func TestDesktopSessionSwitchListCreateSendAndCaches(t *testing.T) {
	backend, log, s := guiFixture(t)
	tt := sessionGUI(s)

	// 启动后第一次刷新就是能力位先验：先验过了才允许读时间线。
	s.refresh()
	waitFor(t, tt, "会话名单先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })
	waitFor(t, tt, "左栏画出两段会话", func() bool { return tt.HasText("main") && tt.HasText("work") })

	// 1. 列会话：名单来自 GET /api/mobile/sessions，main 恒首位。
	if got := s.sessions; len(got) != 2 || got[0] != "main" || got[1] != "work" {
		t.Fatalf("会话名单是 %v，应为 [main work]", got)
	}
	if got := callsMatching(log, "/api/mobile/sessions"); len(got) != 1 || got[0].method != http.MethodGet {
		t.Fatalf("能力位先验应恰好发一次 GET /sessions，实际 %+v", got)
	}
	waitFor(t, tt, "读到 main 的时间线", func() bool { return s.conversation != nil && s.conversation.SessionID == "main" })

	// 2. 切会话：点左栏那一段。切换本身不该产生任何「非 main 以外」的怪请求，
	//    只该让下一次时间线带上 session_id=work。
	if err := tt.Click("work"); err != nil {
		t.Fatalf("点左栏的 work 没接上：%v", err)
	}
	tt.Frame()
	if s.currentSession != "work" {
		t.Fatalf("点了 work 却停在 %q", s.currentSession)
	}
	if got := s.client.ActiveSession(); got != "work" {
		t.Errorf("Client 还连着 %q，切会话没换客户端", got)
	}
	waitFor(t, tt, "切过去后读到 work 的时间线", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "work"
	})
	timelineWork := callsMatching(log, "/api/mobile/timeline?session_id=work")
	if len(timelineWork) == 0 {
		t.Fatalf("切到 work 之后没发带 session_id 的时间线：%v", log.all())
	}
	if got := timelineWork[len(timelineWork)-1].headers.Get(sessionHeader); got != "work" {
		t.Errorf("时间线的 x-crew-session = %q，应与 query 同为 work", got)
	}

	// 3. 发消息：切过去之后点「↑」，这一句必须落到 work。
	log.reset()
	s.input = "切过去之后发的一句"
	tt.Frame()
	if err := tt.Click("↑"); err != nil {
		t.Fatalf("点发送没接上：%v", err)
	}
	waitFor(t, tt, "这一句真的发出去了", func() bool {
		return len(callsMatching(log, "/api/mobile/send")) > 0
	})
	sent := callsMatching(log, "/api/mobile/send")
	last := sent[len(sent)-1]
	if last.url != "/api/mobile/send?session_id=work" {
		t.Errorf("发送打到了 %q，应为 /api/mobile/send?session_id=work", last.url)
	}
	if got := last.headers.Get(sessionHeader); got != "work" {
		t.Errorf("发送的 x-crew-session = %q，应为 work", got)
	}
	if !strings.Contains(last.body, "切过去之后发的一句") {
		t.Errorf("发出去的正文是 %q，没带上那句话", last.body)
	}
	// 落库侧的事实：这句话进了 work 的时间线，main 一条没多。
	if got := len(backend.timeline("work")); got != 2 {
		t.Errorf("work 的时间线应多出这一句（2 条），实际 %d 条", got)
	}
	if got := len(backend.timeline("main")); got != 2 {
		t.Errorf("main 的时间线被串进来一条：现在 %d 条", got)
	}

	// 4. 缓存互不串：切回 main，再切回 work，两段各自的消息都在。
	waitFor(t, tt, "发送之后重读回 work 的时间线", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "work" && len(s.conversation.Messages) == 2
	})
	workConv := s.conversation
	if err := tt.Click("main"); err != nil {
		t.Fatalf("点回 main 没接上：%v", err)
	}
	tt.Frame()
	waitFor(t, tt, "切回 main 读到 main 的时间线", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "main"
	})
	mainConv := s.conversation
	if len(mainConv.Messages) != 2 || mainConv.Messages[0].Text != "主线第一句" {
		t.Errorf("main 的缓存不对：%+v", mainConv.Messages)
	}
	if s.conversations["work"] != workConv {
		t.Error("切回 main 之后 work 的缓存被换掉了")
	}
	if len(workConv.Messages) != 2 || workConv.Messages[0].Text != "工作线第一句" {
		t.Errorf("work 的缓存被 main 顶掉了：%+v", workConv.Messages)
	}

	// 5. 新建会话：点「新建」发 POST，成功后名单多一段并切过去。
	log.reset()
	s.sessionDraft = "beta"
	tt.Frame()
	if err := tt.Click("新建"); err != nil {
		t.Fatalf("点「新建」没接上：%v", err)
	}
	waitFor(t, tt, "新会话回来了", func() bool { return s.currentSession == "beta" })
	created := callsMatching(log, "/api/mobile/sessions")
	if len(created) != 1 || created[0].method != http.MethodPost {
		t.Fatalf("新建应恰好发一次 POST /sessions，实际 %+v", created)
	}
	if strings.TrimSpace(created[0].body) != `{"id":"beta"}` {
		t.Errorf("POST 的正文是 %q，应为 {\"id\":\"beta\"}", created[0].body)
	}
	// 新建这条不带 session_id：它是名单管理，不是某一段会话的读写。
	if strings.Contains(created[0].url, "session_id") {
		t.Errorf("名单管理请求带了 session_id：%s", created[0].url)
	}
	if got := s.sessions; len(got) != 3 || got[2] != "beta" {
		t.Errorf("名单没按 POST 的 sessions[] 刷新：%v", got)
	}
	waitFor(t, tt, "切到新会话并读它的时间线", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "beta"
	})
	if got := callsMatching(log, "/api/mobile/timeline?session_id=beta"); len(got) == 0 {
		t.Errorf("切到 beta 之后没发带 session_id 的时间线：%v", log.all())
	}
	if s.sessionDraft != "" {
		t.Errorf("新建成功后草稿没清掉：%q", s.sessionDraft)
	}
}

// 能力位没先验过之前，界面不画会话列表、也不发任何非 main 请求 —— 桌面端与手机端同一条门禁。
func TestDesktopSessionPaneWaitsForTheCapabilityProbe(t *testing.T) {
	_, log, s := guiFixture(t)
	s.sessionsChecked = false
	tt := ui.NewTester(func(c *ui.Context) {
		s.sessionPane(c, PaletteFor(false))
	}, 329, 480)
	tt.Frame()
	if tt.HasText("新建") || tt.HasText("work") {
		t.Errorf("先验没回来就画了会话列表：%v", tt.Texts())
	}
	if got := len(log.all()); got != 0 {
		t.Errorf("先验没回来却发了 %d 个请求", got)
	}
}

// 调试口的会话动作是**按名字调界面同一个方法**，不是第二套行为。
//
// 这条钉住的是「有、且只有这三个」：session.list / session.set / session.reload。
// 为什么只这三个：手机端 CrewDebug.kt 就是这三个（同名同语义），验收脚本两端能共用；
// 而「新建会话」这类动作界面本来就有一条路（左栏输入框 + 新建），真 GUI 验收要的是
// 「切过去、发一条、切回」，不需要再从调试口造一个 create。
//
// 历史：本文件原先钉的是「调试口零 session.*」，理由是切会话只能人手点像素。
// issue #18 第 2 项要求把这条路变成可自动化的，于是 debug.go 加了这三个动作；
// 具体行为由 debug_session_test.go 逐条验（含能力位门禁与缓存不串）。
func TestDebugBusSessionActionsAreExactlyTheThreePhoneOnes(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)
	raw, err := bus.invoke("actions.list", map[string]json.RawMessage{})
	if err != nil {
		t.Fatal(err)
	}
	listed, _ := raw.(map[string]any)["actions"].([]string)
	if len(listed) == 0 {
		t.Fatal("动作表是空的，读错了对象")
	}
	var found []string
	for _, name := range listed {
		if strings.HasPrefix(name, "session.") {
			found = append(found, name)
		}
	}
	if strings.Join(found, ",") != "session.list,session.reload,session.set" {
		t.Errorf("会话动作应恰好是 session.list/reload/set（与手机端同名），实际 %v", found)
	}
	// 反证：动作表本身是能调通的，不是「什么都没注册」。
	if _, err := bus.invoke("state.dump", map[string]json.RawMessage{}); err != nil {
		t.Fatalf("state.dump 调不通：%v", err)
	}
}

// 切换时旧会话在途的那次刷新不能把新会话的视图顶掉（桌面端切会话最容易串的一处）。
// 这里用真 HTTP：work 的响应被卡在服务端，等切回 main、main 落地之后再放出来。
func TestDesktopLateTimelineFromAnotherSessionDoesNotOverwriteTheView(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	backend := newGUIBackend()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mobile/timeline" && sessionOfRequest(r) == "work" {
			once.Do(func() { <-release })
		}
		switch r.URL.Path {
		case "/api/mobile/sessions":
			writeSessions(w, backend.listed(), "")
		case "/api/mobile/timeline":
			session := sessionOfRequest(r)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": backend.timeline(session), "bots": []any{}, "tasks": []any{},
				"session_id": session, "session_api": sessionAPIBit,
				"sessions": backend.listed(), "default_session_id": defaultSessionID,
			})
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	tt := sessionGUI(s)
	s.refresh()
	waitFor(t, tt, "先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })
	waitFor(t, tt, "main 的视图落地", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "main"
	})
	mainConv := s.conversation

	// 切到 work：它的时间线卡在服务端；再切回 main，让 main 先落地。
	if !s.switchSession("work") {
		t.Fatal("切到 work 没成功")
	}
	tt.Frame()
	if !s.switchSession("main") {
		t.Fatal("切回 main 没成功")
	}
	waitFor(t, tt, "切回 main 之后视图仍是 main", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "main"
	})
	close(release)
	waitFor(t, tt, "迟到的 work 时间线落进它自己的缓存", func() bool {
		return s.conversations["work"] != nil
	})
	// 当前视图仍是 main 的那一份：迟到的 work 只该落在它自己的缓存里。
	if s.conversation == nil || s.conversation.SessionID != "main" ||
		len(s.conversation.Messages) != 2 || s.conversation.Messages[0].Text != "主线第一句" {
		t.Errorf("迟到的 work 顶掉了当前视图：%+v", s.conversation)
	}
	if got := s.conversations["work"]; got == nil || got.SessionID != "work" ||
		len(got.Messages) != 1 || got.Messages[0].Text != "工作线第一句" {
		t.Errorf("work 的缓存不是它自己的那份：%+v", got)
	}
	if len(mainConv.Messages) != 2 {
		t.Errorf("main 的旧缓存被改动了：%+v", mainConv.Messages)
	}
}

// ── 真网关端到端（CREW_REAL_GW=1 才跑）────────────────────────────
//
// 上面几条用假队伍钉住了「Client → app → 界面」这一层。这一条钉的是它下面那一层：
// **真网关 + 真队列**。它起一支自己的 mobilegw（MOBILEGW_STATE 指到 mktemp 目录、端口随机），
// 按网关自己的线上路由（/timeline、/send，不是消息面的 /api/mobile/*）走一遍，
// 再直接读那支网关自己的 mobileq.db，看两段会话的消息是不是各在各的 conversation 里。
//
// 为什么要分成两层：Client 说的是消息面（/api/mobile/*，本机 43499），网关说的是自己的路由（8788）。
// 桌面端真正的门是**消息面**，不是网关 —— 拿网关地址问 /api/mobile/sessions 会 404，
// 桌面端按契约 §1 判成「老后端」锁 main。所以名单/新建在假队伍那层按消息面的真实形状覆盖，
// 而「切会话之后落对哪段会话」这件事实在真网关 + 真队列这层钉住。
//
// 三条边界：绝不连生产 8788 / 43499，绝不读写生产 mobileq.db，跑完杀掉自己起的进程。
func TestDesktopSessionShardingAgainstARealGateway(t *testing.T) {
	if os.Getenv("CREW_REAL_GW") != "1" {
		t.Skip("设 CREW_REAL_GW=1 才跑（会起一支临时 mobilegw）")
	}
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	gateway := filepath.Join(root, "backend", "tools", "mobilegw")
	if _, err := os.Stat(gateway); err != nil {
		t.Fatalf("找不到网关脚本：%v", err)
	}
	state := t.TempDir()
	port := freePort(t)
	command := exec.Command("python3", gateway)
	command.Env = append(os.Environ(),
		"MOBILEGW_STATE="+state,
		"MOBILEGW_PORT="+strconv.Itoa(port),
		"MOBILEGW_HOST=127.0.0.1",
	)
	var output strings.Builder
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatalf("起不来临时网关：%v", err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})

	base := "http://127.0.0.1:" + strconv.Itoa(port)
	waitForGateway(t, base, &output)

	raw, err := os.ReadFile(filepath.Join(state, "mobilegw.token"))
	if err != nil {
		t.Fatalf("读不到临时网关的凭据：%v", err)
	}
	token := strings.TrimSpace(string(raw))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	database := filepath.Join(state, "mobileq.db")

	// 1. 网关自己的路由上没有 /api/mobile/sessions：这正是「桌面端真正的门是消息面」那条事实。
	if status, _ := gatewayStatus(ctx, base, token, http.MethodGet, "/api/mobile/sessions", ""); status != http.StatusNotFound {
		t.Errorf("网关上的 /api/mobile/sessions 应 404，实际 %d", status)
	}

	// 2. 两段会话各读各的时间线（query 形态），回显是那一段。
	mainBody, err := gatewayCall(ctx, base, token, http.MethodGet, "/timeline", "")
	if err != nil {
		t.Fatalf("读 main 时间线失败：%v", err)
	}
	workBody, err := gatewayCall(ctx, base, token, http.MethodGet, "/timeline?session_id=work", "")
	if err != nil {
		t.Fatalf("读 work 时间线失败：%v", err)
	}
	if sessionOfJSON(mainBody) != "main" || sessionOfJSON(workBody) != "work" {
		t.Errorf("回显的会话不对：%q / %q", sessionOfJSON(mainBody), sessionOfJSON(workBody))
	}
	if apiOfJSON(mainBody) != sessionAPIBit || apiOfJSON(workBody) != sessionAPIBit {
		t.Errorf("显式会话的响应没带能力位：%v / %v", apiOfJSON(mainBody), apiOfJSON(workBody))
	}

	// 3. 发消息：work 一条（query 形态）、main 一条（老路径，一个会话字段都不带）。
	if _, err := gatewayCall(ctx, base, token, http.MethodPost, "/send?session_id=work",
		`{"text":"真网关验收：这一句属于 work","mentions":[]}`); err != nil {
		t.Fatalf("往 work 发送失败：%v", err)
	}
	if _, err := gatewayCall(ctx, base, token, http.MethodPost, "/send",
		`{"text":"真网关验收：这一句属于 main","mentions":[]}`); err != nil {
		t.Fatalf("往 main 发送失败：%v", err)
	}

	// 4. 队列侧的事实：直接读这支临时网关自己的 mobileq.db。
	rows := queueByConversation(t, database)
	if rows["work"] != 1 || rows["main"] != 1 {
		t.Fatalf("队列分布是 %v，应为 work:1 main:1", rows)
	}

	// 5. 时间线互不串：work 只看见自己那句，main 只看见自己那句。
	workBody, err = gatewayCall(ctx, base, token, http.MethodGet, "/timeline?session_id=work", "")
	if err != nil {
		t.Fatal(err)
	}
	mainBody, err = gatewayCall(ctx, base, token, http.MethodGet, "/timeline", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(workBody), "属于 work") || strings.Contains(string(workBody), "属于 main") {
		t.Errorf("work 的时间线串了：%s", workBody)
	}
	if !strings.Contains(string(mainBody), "属于 main") || strings.Contains(string(mainBody), "属于 work") {
		t.Errorf("main 的时间线串了：%s", mainBody)
	}

	// 6. header 形态（#14 第 2 项）在同一支真网关上成立：只带 x-crew-session 也落到 work。
	if _, err := gatewayCallWithHeader(ctx, base, token, "/send",
		`{"text":"真网关验收：只带 header 的一句","mentions":[]}`, "work"); err != nil {
		t.Fatalf("只带 header 的发送失败：%v", err)
	}
	if rows := queueByConversation(t, database); rows["work"] != 2 || rows["main"] != 1 {
		t.Errorf("只带 header 的那一句没落进 work：%v", rows)
	}

	// 7. query 与 header 打架时网关回 400，绝不猜哪个算数，也不落库。
	status, err := gatewayConflict(ctx, base, token)
	if err != nil {
		t.Fatalf("冲突请求失败：%v", err)
	}
	if status != http.StatusBadRequest {
		t.Errorf("query 与 header 打架应回 400，实际 %d", status)
	}
	if rows := queueByConversation(t, database); rows["work"] != 2 || rows["main"] != 1 {
		t.Errorf("被拒的请求竟然落库了：%v", rows)
	}
}

// gatewayCall 打一次网关自己的路由（带 X-GW-Token），返回响应体。
func gatewayCall(ctx context.Context, base, token, method, path, body string) ([]byte, error) {
	return gatewayRequest(ctx, base, token, method, path, body, "")
}

// gatewayCallWithHeader 只带 x-crew-session（不带 query）打一次，验 header 形态。
func gatewayCallWithHeader(ctx context.Context, base, token, path, body, session string) ([]byte, error) {
	return gatewayRequest(ctx, base, token, http.MethodPost, path, body, session)
}

func gatewayRequest(ctx context.Context, base, token, method, path, body, session string) ([]byte, error) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("X-GW-Token", token)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if session != "" {
		request.Header.Set(sessionHeader, session)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s %s 返回 %d：%s", method, path, response.StatusCode, payload)
	}
	return payload, nil
}

// gatewayStatus 只关心状态码（用于断言「这条路由不存在」）。
func gatewayStatus(ctx context.Context, base, token, method, path, body string) (int, error) {
	request, err := http.NewRequestWithContext(ctx, method, base+path, strings.NewReader(body))
	if err != nil {
		return 0, err
	}
	request.Header.Set("X-GW-Token", token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}

// gatewayConflict 同时给出互相打架的 query 与 header，读回状态码。
func gatewayConflict(ctx context.Context, base, token string) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/send?session_id=main", strings.NewReader(`{"text":"打架的一句","mentions":[]}`))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GW-Token", token)
	request.Header.Set(sessionHeader, "work")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}

// sessionOfJSON / apiOfJSON 从网关的回应里读回会话与能力位。
func sessionOfJSON(body []byte) string {
	var parsed struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(body, &parsed)
	return parsed.SessionID
}

func apiOfJSON(body []byte) int {
	var parsed struct {
		SessionAPI int `json:"session_api"`
	}
	_ = json.Unmarshal(body, &parsed)
	return parsed.SessionAPI
}

// freePort 找一个当下空着的回环端口。
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("找空端口失败：%v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// waitForGateway 等临时网关开始应答 /health。
func waitForGateway(t *testing.T, base string, output *strings.Builder) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(base + "/health")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("临时网关没起来：%s", output.String())
}

// queueByConversation 直接读网关的队列库，数每段会话各有多少条消息。
// 走系统自带的 sqlite3 CLI：这条用例不该为了一次只读统计把 SQLite 驱动塞进 desktop 的 go.mod。
func queueByConversation(t *testing.T, path string) map[string]int {
	t.Helper()
	output, err := exec.Command("sqlite3", path,
		"SELECT conversation || ' ' || COUNT(*) FROM messages GROUP BY conversation").Output()
	if err != nil {
		t.Fatalf("读队列库失败：%v", err)
	}
	counted := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		count, convErr := strconv.Atoi(fields[1])
		if convErr != nil {
			t.Fatalf("读不懂队列统计 %q：%v", line, convErr)
		}
		counted[fields[0]] = count
	}
	return counted
}

// 真实 unix socket 上的调试口：会话动作走的就是外部自动化看到的那一份 JSON。
//
// 这条走的是 serveDebug 那条真路径（CREW_DEBUG_SOCK 指到临时文件、一条 JSON 进一条 JSON 出），
// 不是进程内 bus.invoke —— 但它**不起窗口**：mygo 窗口一建就会前置，而本轮要求不抢焦点。
// 动作表本身与窗口无关（newDebugBus 只看 app），所以 socket 级验证就是等价证据；
// 真窗口那一遍另走一次手工取证（见 docs/PHASE_DESKTOP_SESSION_CHECK.md）。
func TestDebugSocketExposesSessionActions(t *testing.T) {
	// unix socket 路径有长度上限（macOS 104 字节），t.TempDir() 那条太深：改用 /tmp 下的短名。
	socket := filepath.Join("/tmp", fmt.Sprintf("crew-debug-%d.sock", os.Getpid()))
	t.Cleanup(func() { _ = os.Remove(socket) })
	t.Setenv("CREW_DEBUG_SOCK", socket)
	t.Setenv("CREW_DEBUG", "1")

	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := bus.serveDebug(ctx); err != nil {
		t.Fatalf("调试口开不起来：%v", err)
	}

	// actions.list 走真 socket：拿到的就是外部自动化看到的那一份。
	response, err := debugOverSocket(socket, "actions.list", nil)
	if err != nil {
		t.Fatalf("socket 上 actions.list 失败：%v", err)
	}
	if ok, _ := response["ok"].(bool); !ok {
		t.Fatalf("actions.list 回了 %v", response)
	}
	result, _ := response["result"].(map[string]any)
	listed, _ := result["actions"].([]any)
	if len(listed) == 0 {
		t.Fatalf("动作表是空的：%v", response)
	}
	seen := map[string]bool{}
	for _, entry := range listed {
		name, _ := entry.(string)
		seen[name] = true
	}
	for _, want := range []string{"session.list", "session.set", "session.reload"} {
		if !seen[want] {
			t.Errorf("socket 上缺会话动作 %q", want)
		}
	}

	// 反证：socket 通路本身是活的，state.dump 能读回界面状态。
	response, err = debugOverSocket(socket, "state.dump", nil)
	if err != nil {
		t.Fatalf("socket 上 state.dump 失败：%v", err)
	}
	if ok, _ := response["ok"].(bool); !ok {
		t.Fatalf("state.dump 回了 %v", response)
	}
	// 未知动作仍明确报错，不静默成功。
	if _, err := debugOverSocket(socket, "session.nope", map[string]any{"id": "work"}); err == nil {
		t.Fatal("session.nope 竟然成功了：未知动作必须报错")
	}
	// 能力位没到 live（这个 app 没连后端）时，socket 上的 session.set 如实被拒。
	if _, err := debugOverSocket(socket, "session.set", map[string]any{"session": "work"}); err == nil {
		t.Fatal("没先验过能力位却切成功了")
	}
}

// debugOverSocket 像外部自动化那样：连 unix socket，发一行 JSON，读一行 JSON。
func debugOverSocket(path, action string, args map[string]any) (map[string]any, error) {
	connection, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	payload, err := json.Marshal(map[string]any{"action": action, "args": args})
	if err != nil {
		return nil, err
	}
	if _, err := connection.Write(append(payload, '\n')); err != nil {
		return nil, err
	}
	var response map[string]any
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return nil, err
	}
	if ok, _ := response["ok"].(bool); !ok {
		message, _ := response["error"].(string)
		return response, fmt.Errorf("调试口拒绝 %s：%s", action, message)
	}
	return response, nil
}

// ── 真消息面只读验收（CREW_REAL_LAN=1 才跑）──────────────────────
//
// 这一条打的是**桌面端真正的那道门**：本机消息面 43499（本机已配对凭据）。
// 它只做读：GET /api/mobile/sessions、两段 timeline。不发消息 —— 往真队列里发一句会真的派活
// 给 worker，那不是「验桌面端切会话」该付的代价；「切过去之后发的那句落对会话」由上面
// 真网关 + 真队列那条用例按字节钉住（真落库、真分片、query/header 双形态、冲突 400）。
//
// 凭据从 ~/.config/crew-desktop/credential.json 读（桌面端自己的那份），不打印 token。
func TestDesktopSessionAgainstTheLivePhoneSurface(t *testing.T) {
	if os.Getenv("CREW_REAL_LAN") != "1" {
		t.Skip("设 CREW_REAL_LAN=1 才跑（读本机 43499 的真实消息面，只读）")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	saved, ok := loadCredential(filepath.Join(home, ".config", "crew-desktop", "credential.json"))
	if !ok {
		t.Skip("本机还没有桌面端凭据，先配对")
	}
	client := New(saved.Base, saved.Token, saved.DeviceID)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// 1. 列会话：消息面是这套协议的宿主，GET /sessions 带能力位。
	view, err := client.Sessions(ctx)
	if err != nil {
		t.Fatalf("列会话失败（%s）：%v", saved.Base, err)
	}
	if view.SessionAPI != sessionAPIBit || len(view.Sessions) == 0 || view.Sessions[0] != defaultSessionID {
		t.Fatalf("名单是 %+v，应带能力位且 main 在首位", view)
	}
	t.Logf("真实消息面 %s 的会话名单：%v（缺省 %s）", saved.Base, view.Sessions, view.DefaultSessionID)

	// 2. 两段会话各读各的时间线：回显的 session_id 就是请求那一段，消息互不重叠。
	client.confirmSessions()
	mainConv, err := client.Timeline(ctx)
	if err != nil {
		t.Fatalf("读 main 时间线失败：%v", err)
	}
	if mainConv.SessionID != defaultSessionID {
		t.Errorf("main 的回显是 %q", mainConv.SessionID)
	}
	for _, other := range view.Sessions[1:] {
		conv, err := client.WithSession(other).Timeline(ctx)
		if err != nil {
			t.Fatalf("读 %s 时间线失败：%v", other, err)
		}
		if conv.SessionID != other {
			t.Errorf("%s 的回显是 %q", other, conv.SessionID)
		}
		t.Logf("%s 会话：%d 条消息，queued %d 条", other, len(conv.Messages), len(conv.Queued))
		// 互不串：两段会话的正文集合不该有交集（有交集说明某一段把另一段的读回来了）。
		mainTexts := map[string]bool{}
		for _, message := range mainConv.Messages {
			mainTexts[message.ID] = true
		}
		for _, message := range conv.Messages {
			if mainTexts[message.ID] {
				t.Errorf("%s 与 main 读到了同一条消息 %q：两段会话的时间线串了", other, message.ID)
			}
		}
	}
	t.Logf("main 会话：%d 条消息，queued %d 条", len(mainConv.Messages), len(mainConv.Queued))
}
