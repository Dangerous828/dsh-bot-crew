package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 多会话（S3 桌面端 + S4 header 形态）。盯住：session_id 走 query、非 main 同值双写
// x-crew-session、默认 main 一个会话字段都不带、能力位先验三态、每会话一份缓存、
// 「老后端锁 main、非法 id 本地拒绝」。
// 会话相关的测试都从客户端的公开方法与 app 的公共状态入口进去，不看内部实现。

type sessionCall struct {
	method  string
	url     string
	body    string
	headers http.Header
}

type sessionLog struct {
	mu    sync.Mutex
	calls []sessionCall
}

func (l *sessionLog) record(r *http.Request) {
	body := readAll(r)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, sessionCall{method: r.Method, url: r.URL.String(), body: body, headers: r.Header.Clone()})
}

func readAll(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	raw, _ := io.ReadAll(r.Body)
	return string(raw)
}

func (l *sessionLog) all() []sessionCall {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]sessionCall, len(l.calls))
	copy(out, l.calls)
	return out
}

func (l *sessionLog) count() int { return len(l.all()) }

func (l *sessionLog) last() sessionCall {
	calls := l.all()
	if len(calls) == 0 {
		return sessionCall{}
	}
	return calls[len(calls)-1]
}

func (l *sessionLog) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = nil
}

// sessionFixture 起一个只在测试里活着的消息面，逐条记下真实发出去的请求。
func sessionFixture(t *testing.T, reply func(http.ResponseWriter, *http.Request)) (*httptest.Server, *sessionLog) {
	t.Helper()
	log := &sessionLog{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.record(r)
		if reply != nil {
			reply(w, r)
			return
		}
		// 默认假后端是「已升级」的：GET /sessions 报能力位，其余接口回空对象。
		if r.Method == http.MethodGet && r.URL.Path == "/api/mobile/sessions" {
			_, _ = w.Write([]byte(`{"sessions":["main","work"],"default_session_id":"main","session_api":1}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)
	return server, log
}

func emptyReply(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }

// sessionCapableFixture 按真顺序走一遍先验：GET /sessions 拿到 session_api:1，
// 再把探测那条请求从记录里抹掉，后续断言只看业务请求。
func sessionCapableFixture(t *testing.T) (*httptest.Server, *sessionLog, *Client) {
	t.Helper()
	server, log := sessionFixture(t, nil)
	client := New(server.URL, "secret", "dev-1")
	if _, err := client.Sessions(context.Background()); err != nil {
		t.Fatalf("先验没过：%v", err)
	}
	log.reset()
	return server, log, client
}

func TestSessionNamesAreCheckedLocally(t *testing.T) {
	cases := []struct {
		id string
		ok bool
	}{
		{"main", true}, {"work", true}, {"trail-", true}, {"a", true},
		{strings.Repeat("a", 32), true},
		{"", false}, {"Work", false}, {"work_x", false}, {" work", false},
		{"work ", false}, {"-work", false}, {"work.1", false},
		{strings.Repeat("a", 33), false},
	}
	for _, tc := range cases {
		if got := validSessionID(tc.id); got != tc.ok {
			t.Errorf("validSessionID(%q) = %v, want %v", tc.id, got, tc.ok)
		}
	}
}

// 会话 id 走 query，非 main 时另加同值 x-crew-session header（#14 第 2 项 / 契约 §1）。
// body 不认；header 的值只从 query 派生，所以两者不可能不一致。
func TestNonMainSessionUsesQueryAndSameValueHeader(t *testing.T) {
	_, log, client := sessionCapableFixture(t)
	client = client.WithSession("work")
	ctx := context.Background()

	cases := []struct {
		name, want string
		call       func() error
	}{
		{"timeline", "/api/mobile/timeline?session_id=work", func() error {
			_, err := client.Timeline(ctx)
			return err
		}},
		{"send", "/api/mobile/send?session_id=work", func() error {
			_, err := client.Send(ctx, "在吗", nil)
			return err
		}},
		{"read", "/api/mobile/read?session_id=work", func() error {
			return client.ReportRead(ctx, "m-1")
		}},
		{"withdraw", "/api/mobile/withdraw?session_id=work", func() error {
			return client.Withdraw(ctx, "r-1")
		}},
		{"send-again", "/api/mobile/send?session_id=work", func() error {
			return client.SendAgain(ctx, "r-1", "在吗", nil)
		}},
		{"steer", "/api/mobile/steer?session_id=work", func() error {
			return client.Steer(ctx, "tk-1", "r-1")
		}},
		{"steer-text", "/api/mobile/steer?session_id=work", func() error {
			return client.SteerText(ctx, "tk-1", "r-1", "补一句")
		}},
	}
	for _, tc := range cases {
		log.reset()
		if err := tc.call(); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		got := log.last()
		if got.url != tc.want {
			t.Errorf("%s 打到了 %q，契约是 %q", tc.name, got.url, tc.want)
		}
		// 旧形态的头名一概不认；S4 只认 x-crew-session，且值必须与 query 同值。
		if got.headers.Get("session_id") != "" || got.headers.Get("X-Session-Id") != "" {
			t.Errorf("%s 用了旧形态的会话头：%v", tc.name, got.headers)
		}
		if got := got.headers.Get(sessionHeader); got != "work" {
			t.Errorf("%s 的 x-crew-session = %q，应与 query 同为 work", tc.name, got)
		}
		if strings.Contains(got.body, "session_id") {
			t.Errorf("%s 把会话放进了 body：%s", tc.name, got.body)
		}
	}
}

// 默认 main 一个会话字段都不带（query 与 header 都不加），老路径逐字不变。
func TestDefaultMainCarriesNoSessionField(t *testing.T) {
	_, log, client := sessionCapableFixture(t)
	ctx := context.Background()
	log.reset()
	if _, err := client.Timeline(ctx); err != nil {
		t.Fatal(err)
	}
	got := log.last()
	if strings.Contains(got.url, "session_id") {
		t.Errorf("默认 main 的 URL 带了会话参数：%q", got.url)
	}
	if got.headers.Get(sessionHeader) != "" {
		t.Errorf("默认 main 带了 x-crew-session：%v", got.headers)
	}
}

// 方法上的可选 session 覆盖 Client 的当前会话；显式 main 仍不带参数。
func TestExplicitSessionOverridesClientState(t *testing.T) {
	server, log, mainClient := sessionCapableFixture(t)
	ctx := context.Background()
	if _, err := mainClient.Timeline(ctx, "work"); err != nil {
		t.Fatal(err)
	}
	if got := log.last().url; got != "/api/mobile/timeline?session_id=work" {
		t.Errorf("显式 work = %q", got)
	}
	if _, err := mainClient.WithSession("work").Timeline(ctx, "main"); err != nil {
		t.Fatal(err)
	}
	if got := log.last().url; got != "/api/mobile/timeline" {
		t.Errorf("显式 main = %q，应该逐字回到老路径", got)
	}
	if _, err := New(server.URL, "secret", "").WithSession("work").Timeline(ctx, "Bad_ID"); err == nil {
		t.Error("显式非法会话名没有被本地拒绝")
	}
}

// 缺省 main 的所有会话请求逐字不变：一个 ? 都不多。
func TestDefaultMainPathsStayUnchanged(t *testing.T) {
	server, log := sessionFixture(t, emptyReply)
	client := New(server.URL, "secret", "")
	ctx := context.Background()

	calls := []struct {
		name, want string
		call       func() error
	}{
		{"timeline", "/api/mobile/timeline", func() error { _, err := client.Timeline(ctx); return err }},
		{"send", "/api/mobile/send", func() error { _, err := client.Send(ctx, "在吗", nil); return err }},
		{"read", "/api/mobile/read", func() error { return client.ReportRead(ctx, "m-1") }},
		{"withdraw", "/api/mobile/withdraw", func() error { return client.Withdraw(ctx, "r-1") }},
		{"send-again", "/api/mobile/send", func() error { return client.SendAgain(ctx, "r-1", "在吗", nil) }},
		{"steer", "/api/mobile/steer", func() error { return client.Steer(ctx, "tk-1", "r-1") }},
		{"models", "/api/mobile/models", func() error { _, err := client.Models(ctx); return err }},
	}
	for _, tc := range calls {
		log.reset()
		if err := tc.call(); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got := log.last().url; got != tc.want {
			t.Errorf("%s 打到了 %q，老路径是 %q", tc.name, got, tc.want)
		}
	}
	if client.ActiveSession() != defaultSessionID {
		t.Errorf("Client 的缺省会话 = %q，应为 main", client.ActiveSession())
	}
}

// 已有 query 的接口用 & 追加，不覆盖原来的参数。
func TestSessionQueryJoinsAnExistingQuery(t *testing.T) {
	if got := sessionQuery("/api/mobile/read?ticket=t1", "work"); got != "/api/mobile/read?ticket=t1&session_id=work" {
		t.Errorf("带 query 时拼成了 %q", got)
	}
	if got := sessionQuery("/api/mobile/timeline", "main"); got != "/api/mobile/timeline" {
		t.Errorf("main 不该追加参数，得到 %q", got)
	}
	if got := sessionQuery("/api/mobile/timeline", ""); got != "/api/mobile/timeline" {
		t.Errorf("空会话不该追加参数，得到 %q", got)
	}
}

// 能力位先验三态：200 + session_api:1 启用；404 / 缺能力位视为老后端；网络错误如实说读不到。
func TestSessionsCapabilityProbeThreeStates(t *testing.T) {
	ctx := context.Background()

	t.Run("capable", func(t *testing.T) {
		server, log := sessionFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"sessions":["main","work"],"default_session_id":"main","session_api":1}`))
		})
		view, err := New(server.URL, "secret", "").Sessions(ctx)
		if err != nil {
			t.Fatalf("能力位齐备却报错：%v", err)
		}
		if view.SessionAPI != 1 || len(view.Sessions) != 2 || view.Sessions[0] != "main" || view.DefaultSessionID != "main" {
			t.Errorf("GET 形状解析错：%+v", view)
		}
		if got := log.last(); got.method != http.MethodGet || got.url != "/api/mobile/sessions" {
			t.Errorf("探测打成了 %s %s", got.method, got.url)
		}
	})

	t.Run("404 legacy", func(t *testing.T) {
		server, _ := sessionFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"Unknown operation"}`))
		})
		_, err := New(server.URL, "secret", "").Sessions(ctx)
		if !errors.Is(err, ErrSessionsUnsupported) {
			t.Fatalf("404 应视为老后端，实际 %v", err)
		}
	})

	t.Run("missing capability bit", func(t *testing.T) {
		server, _ := sessionFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"sessions":["main"],"default_session_id":"main"}`))
		})
		_, err := New(server.URL, "secret", "").Sessions(ctx)
		if !errors.Is(err, ErrSessionsUnsupported) {
			t.Fatalf("200 但缺 session_api:1 应视为老后端，实际 %v", err)
		}
	})

	t.Run("network unreachable", func(t *testing.T) {
		server, _ := sessionFixture(t, emptyReply)
		base := server.URL
		server.Close()
		_, err := New(base, "secret", "").Sessions(ctx)
		if !errors.Is(err, ErrSessionsUnavailable) {
			t.Fatalf("网络错误应如实说读不到会话列表，实际 %v", err)
		}
	})
}

// POST /sessions 的响应没有 default_session_id，形状与 GET 不能混着解析。
func TestCreateSessionUsesTheS1ResponseShape(t *testing.T) {
	server, log := sessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.String() != "/api/mobile/sessions" {
			t.Errorf("新建打成了 %s %s", r.Method, r.URL.String())
		}
		_, _ = w.Write([]byte(`{"id":"work","sessions":["main","work"],"session_api":1}`))
	})
	client := New(server.URL, "secret", "").WithSession("work-other")
	view, err := client.CreateSession(context.Background(), "work")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if view.ID != "work" || len(view.Sessions) != 2 || view.SessionAPI != 1 || view.DefaultSessionID != "" {
		t.Errorf("POST 形状解析错：%+v", view)
	}
	got := log.last()
	if got.body != `{"id":"work"}` {
		t.Errorf("新建 body = %s，契约是 {\"id\":\"work\"}", got.body)
	}
	if strings.Contains(got.url, "session_id") {
		t.Errorf("名单管理请求不该带 session_id：%s", got.url)
	}
}

func TestCreateSessionReportsTheBackendRefusal(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{http.StatusBadRequest, `{"error":"invalid_session"}`, "invalid_session"},
		{http.StatusConflict, `{"error":"unsupported_session"}`, "unsupported_session"},
		{http.StatusServiceUnavailable, `{"error":"Session registry is unavailable"}`, "503"},
	} {
		server, _ := sessionFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		})
		view, err := New(server.URL, "secret", "").CreateSession(context.Background(), "work")
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%d 应如实带出 %q，实际 view=%+v err=%v", tc.status, tc.want, view, err)
		}
		if view != nil {
			t.Errorf("%d 时不该给出一份名单：%+v", tc.status, view)
		}
	}
}

// 非法 id 在提交前就被本地挡住：一个请求都不发。
func TestCreateSessionRejectsInvalidIDWithoutARequest(t *testing.T) {
	server, log := sessionFixture(t, emptyReply)
	client := New(server.URL, "secret", "")
	for _, id := range []string{"", "Work", "work_x", "-work", "work 2", strings.Repeat("a", 33)} {
		if _, err := client.CreateSession(context.Background(), id); !errors.Is(err, ErrInvalidSessionID) {
			t.Errorf("CreateSession(%q) 应本地拒绝，实际 %v", id, err)
		}
	}
	if got := log.count(); got != 0 {
		t.Errorf("本地拒绝却发了 %d 个请求", got)
	}
}

// timeline 回显四字段；老响应缺字段时按 main 兼容，不冒充别的会话。
func TestTimelineReadsSessionEchoAndFallsBackToMain(t *testing.T) {
	t.Run("new response", func(t *testing.T) {
		server, _ := sessionFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[],
			  "session_id":"work","session_api":1,"sessions":["main","work"],"default_session_id":"main"}`))
		})
		// 这一条只测 timeline 四字段的解析；能力位先验由专门的用例钉住。
		client := New(server.URL, "secret", "").WithSession("work")
		client.confirmSessions()
		conv, err := client.Timeline(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if conv.SessionID != "work" || conv.SessionAPI != 1 || len(conv.Sessions) != 2 || conv.DefaultSessionID != "main" {
			t.Errorf("四字段回显没读全：%+v", conv)
		}
	})

	t.Run("old response", func(t *testing.T) {
		server, _ := sessionFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[]}`))
		})
		conv, err := New(server.URL, "secret", "").Timeline(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if conv.SessionID != "main" || conv.SessionAPI != 0 || len(conv.Sessions) != 0 {
			t.Errorf("老响应应回落 main，实际 %+v", conv)
		}
	})
}

// ── app 状态层：能力位先验、缓存隔离、锁 main、当前会话持久化 ─────────────

func sessionInt(n int) *int { return &n }

// sessionApp 造一个不连真实后端的窗口，并把凭据落点换到临时目录。
func sessionApp(t *testing.T) (*app, string) {
	t.Helper()
	s := newApp(nil)
	path := filepath.Join(t.TempDir(), "credential.json")
	if err := saveCredential(path, Credential{DeviceID: "crew-desktop", Token: "secret", Base: "http://127.0.0.1:1"}); err != nil {
		t.Fatal(err)
	}
	s.credentialFile = path
	return s, path
}

func waitForSessionCall(t *testing.T, log *sessionLog, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, call := range log.all() {
			if call.url == want {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("没等到 %q；发出的是 %v", want, log.all())
}

// 能力位先验的三态在 app 上各落到哪一句话、哪一段会话。
func TestSessionCapabilityGateThreeStates(t *testing.T) {
	t.Run("capable keeps the restored session", func(t *testing.T) {
		server, _ := sessionFixture(t, emptyReply)
		s, _ := sessionApp(t)
		s.client = New(server.URL, "secret", "")
		s.currentSession = "work"
		s.applySessions(sessionsResult{view: &SessionsView{
			Sessions: []string{"main", "work"}, DefaultSessionID: "main", SessionAPI: 1,
		}})
		if !s.sessionAPI || !s.sessionsChecked || s.sessionBusy {
			t.Fatalf("能力位齐备却没启用：%+v", s)
		}
		if s.currentSession != "work" || s.client.ActiveSession() != "work" || s.sessionNote != "" {
			t.Errorf("应留在 work：session=%q client=%q note=%q", s.currentSession, s.client.ActiveSession(), s.sessionNote)
		}
		if len(s.sessions) != 2 || s.sessions[0] != "main" {
			t.Errorf("名单没按 GET 的形状刷新：%v", s.sessions)
		}
	})

	t.Run("legacy locks main and sends no non-main request", func(t *testing.T) {
		server, log := sessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/mobile/sessions" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			emptyReply(w, r)
		})
		s, _ := sessionApp(t)
		s.client = New(server.URL, "secret", "")
		s.currentSession = "work" // 上次在这台机器上打开的是 work
		s.applySessions(sessionsResult{err: ErrSessionsUnsupported})
		if s.sessionAPI || !s.sessionsChecked || s.sessionBusy {
			t.Fatalf("老后端没锁住：%+v", s)
		}
		if s.currentSession != "main" || s.client.ActiveSession() != "main" {
			t.Errorf("老后端应锁 main，实际 session=%q client=%q", s.currentSession, s.client.ActiveSession())
		}
		if s.sessionNote != legacySessionNote {
			t.Errorf("提示应是那句实话，实际 %q", s.sessionNote)
		}
		waitForSessionCall(t, log, "/api/mobile/timeline")
		for _, call := range log.all() {
			if strings.Contains(call.url, "session_id") {
				t.Errorf("老后端仍发了非 main 请求：%s", call.url)
			}
		}
	})

	t.Run("unavailable says it could not read the list", func(t *testing.T) {
		s, _ := sessionApp(t)
		s.applySessions(sessionsResult{err: ErrSessionsUnavailable})
		if s.sessionAPI || s.currentSession != defaultSessionID || s.sessionNote != unavailableSessionsNote {
			t.Errorf("读不到时应锁 main 并如实说，实际 %+v", s)
		}
	})
}

// 门禁是硬要求：先验没回来之前，refresh 连一条时间线都不发。
func TestRefreshWaitsForTheCapabilityProbe(t *testing.T) {
	server, log := sessionFixture(t, emptyReply)
	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "")
	s.currentSession = "work"
	s.sessionsChecked = false

	s.refresh()
	if !s.sessionBusy || s.sessionsChecked {
		t.Fatalf("refresh 没有先去要会话名单：busy=%v checked=%v", s.sessionBusy, s.sessionsChecked)
	}
	waitForSessionCall(t, log, "/api/mobile/sessions")
	for _, call := range log.all() {
		if call.url != "/api/mobile/sessions" {
			t.Errorf("先验未完成时发出了 %s", call.url)
		}
	}
	select {
	case result := <-s.sessionsCh:
		// 这个假后端回的是 {}（缺 session_api）→ 老后端：锁 main。
		s.applySessions(result)
	case <-time.After(3 * time.Second):
		t.Fatal("先验结果没有回到主线程通道")
	}
	if s.currentSession != defaultSessionID || s.sessionNote != legacySessionNote {
		t.Errorf("缺能力位应锁 main 并如实提示，实际 session=%q note=%q", s.currentSession, s.sessionNote)
	}
	waitForSessionCall(t, log, "/api/mobile/timeline")
	for _, call := range log.all() {
		if strings.Contains(call.url, "session_id") {
			t.Errorf("锁 main 之后仍发了显式会话请求：%s", call.url)
		}
	}
}

// 每会话一份缓存：切走再切回，A 的 messages / queued / declined / unread /
// unread_replies / tasks 一个字都不许被 B 顶掉。
func TestSwitchSessionKeepsCachesApart(t *testing.T) {
	s, path := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.currentSession = defaultSessionID
	mainConv := &Conversation{
		SessionID:     "main",
		Messages:      []Message{{ID: "a1", Text: "A 的话"}},
		Queued:        []string{"qa"},
		Declined:      []Declined{{RequestID: "qa", Reason: "A 没动手"}},
		Unread:        Unread{Count: sessionInt(2), State: "live"},
		UnreadReplies: Unread{Count: sessionInt(1), State: "live"},
		Tasks:         []Task{{ID: "ta", Open: true}},
	}
	workConv := &Conversation{
		SessionID:     "work",
		Messages:      []Message{{ID: "b1", Text: "B 的话"}},
		Queued:        []string{"qb"},
		Declined:      []Declined{{RequestID: "qb", Reason: "B 没动手"}},
		Unread:        Unread{Count: sessionInt(5), State: "live"},
		UnreadReplies: Unread{Count: sessionInt(3), State: "live"},
		Tasks:         []Task{{ID: "tb", Open: true}},
	}
	s.conversations = map[string]*Conversation{"main": mainConv, "work": workConv}
	s.conversation = mainConv

	if !s.switchSession("work") {
		t.Fatal("切到 work 没成功")
	}
	if s.currentSession != "work" || s.conversation != workConv {
		t.Fatalf("切过去后显示的不是 work 的缓存：session=%q", s.currentSession)
	}
	if !s.switchSession("main") {
		t.Fatal("切回 main 没成功")
	}
	if s.conversation != mainConv || len(s.conversations) != 2 {
		t.Fatalf("切回 main 没拿回自己的缓存：%+v", s.conversations)
	}
	if len(mainConv.Messages) != 1 || mainConv.Messages[0].Text != "A 的话" ||
		len(mainConv.Queued) != 1 || mainConv.Queued[0] != "qa" ||
		len(mainConv.Declined) != 1 || mainConv.Declined[0].Reason != "A 没动手" ||
		!mainConv.Unread.Known() || mainConv.Unread.CountOf() != 2 ||
		!mainConv.UnreadReplies.Known() || mainConv.UnreadReplies.CountOf() != 1 ||
		len(mainConv.Tasks) != 1 || mainConv.Tasks[0].ID != "ta" {
		t.Errorf("main 的六类字段被别的会话串了：%+v", mainConv)
	}
	if got := currentSessionFrom(path); got != "main" {
		t.Errorf("切回 main 没写进凭据，读到 %q", got)
	}
}

// 切换前在途的旧会话响应：只落到它自己的缓存，不覆盖当前这一段。
func TestLateTimelineFromAnotherSessionDoesNotLeak(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.currentSession = "work"
	workConv := &Conversation{SessionID: "work", Messages: []Message{{ID: "b1", Text: "B 的话"}}}
	s.conversations = map[string]*Conversation{"work": workConv}
	s.conversation = workConv

	late := &Conversation{SessionID: "main", SessionAPI: sessionAPIBit,
		Sessions: []string{"main", "ghost"},
		Messages: []Message{{ID: "a1", Text: "迟到的 A 的话"}}}
	s.applyConversation(late)
	if s.conversation != workConv {
		t.Errorf("迟到的 main 时间线顶掉了当前 work 的视图：%+v", s.conversation)
	}
	if s.conversations["main"] != late {
		t.Error("迟到的结果没有落到 main 自己的缓存")
	}
	if len(s.sessions) != 2 || s.sessions[1] != "work" {
		t.Errorf("迟到的 timeline 回显改写了会话名单：%v", s.sessions)
	}
}

// 新建失败（400 / 409 / 503）如实说，名单和本地条目一格都不动。
func TestCreateSessionFailureAddsNoLocalEntry(t *testing.T) {
	for _, reason := range []string{
		`新建会话没成功（400）：{"error":"invalid_session"}`,
		`新建会话没成功（409）：{"error":"unsupported_session"}`,
		`新建会话没成功（503）：{"error":"Session registry is unavailable"}`,
	} {
		s, _ := sessionApp(t)
		server, log := sessionFixture(t, emptyReply)
		s.client = New(server.URL, "secret", "")
		s.sessionsChecked, s.sessionAPI, s.sessionBusy = true, true, true
		s.sessions = []string{"main"}
		s.currentSession = defaultSessionID
		s.sessionDraft = "work"
		s.applyCreatedSession(createdSessionResult{err: errors.New(reason), id: "work"})
		if len(s.sessions) != 1 || s.sessions[0] != "main" {
			t.Errorf("%q：名单被改成了 %v", reason, s.sessions)
		}
		if s.currentSession != "main" || s.sessionDraft != "work" {
			t.Errorf("%q：本地状态被改了：session=%q draft=%q", reason, s.currentSession, s.sessionDraft)
		}
		if _, exists := s.conversations["work"]; exists {
			t.Errorf("%q：失败却新建了本地缓存", reason)
		}
		if !strings.Contains(s.sessionNote, "没成功") || s.sessionBusy {
			t.Errorf("%q：没有如实回执，note=%q busy=%v", reason, s.sessionNote, s.sessionBusy)
		}
		if got := log.count(); got != 0 {
			t.Errorf("%q：应用失败回执时又发了 %d 个请求", reason, got)
		}
	}
}

// POST 的 200 用返回的 sessions[] 刷新名单并切到新会话；它不带 default_session_id。
func TestCreateSessionSuccessSwitchesToTheNewSession(t *testing.T) {
	server, log := sessionFixture(t, emptyReply)
	s, path := sessionApp(t)
	s.client = New(server.URL, "secret", "")
	s.sessionsChecked, s.sessionAPI, s.sessionBusy = true, true, true
	s.sessions = []string{"main"}
	s.currentSession = defaultSessionID
	s.sessionDraft = "work"
	mainConv := &Conversation{SessionID: "main", Messages: []Message{{ID: "a1", Text: "A 的话"}}}
	s.conversations["main"] = mainConv
	s.conversation = mainConv

	s.applyCreatedSession(createdSessionResult{id: "work", view: &SessionsView{
		ID: "work", Sessions: []string{"main", "work"}, SessionAPI: 1,
	}})
	if len(s.sessions) != 2 || s.sessions[1] != "work" {
		t.Errorf("名单没按 POST 的 sessions[] 刷新：%v", s.sessions)
	}
	if s.currentSession != "work" || s.client.ActiveSession() != "work" {
		t.Errorf("没切到新会话：session=%q client=%q", s.currentSession, s.client.ActiveSession())
	}
	if s.sessionDraft != "" || s.sessionNote != "" || s.sessionBusy {
		t.Errorf("切换后草稿/回执没收拾干净：draft=%q note=%q busy=%v", s.sessionDraft, s.sessionNote, s.sessionBusy)
	}
	if s.conversations["main"] != mainConv {
		t.Error("切到新会话把 main 的缓存丢了")
	}
	if got := currentSessionFrom(path); got != "work" {
		t.Errorf("当前会话没持久化，读到 %q", got)
	}
	waitForSessionCall(t, log, "/api/mobile/timeline?session_id=work")
}

// 非法 id 与不在名单里的 id 都在本地挡掉，一个请求都不发。
func TestInvalidAndUnknownSessionsAreRejectedLocally(t *testing.T) {
	server, log := sessionFixture(t, emptyReply)
	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "")
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.currentSession = defaultSessionID

	if s.switchSession("ghost") {
		t.Error("不在名单里的会话竟然切了过去")
	}
	if s.switchSession("Bad_ID") {
		t.Error("非法会话名竟然切了过去")
	}
	s.sessionDraft = "Bad_ID"
	s.createSession()
	if got := log.count(); got != 0 {
		t.Errorf("本地拒绝却发了 %d 个请求：%v", got, log.all())
	}
	if s.currentSession != "main" || s.client.ActiveSession() != "main" {
		t.Errorf("本地拒绝却改了当前会话：%q / %q", s.currentSession, s.client.ActiveSession())
	}
	if !sessionListed("work", s.sessions) || sessionListed("ghost", s.sessions) {
		t.Error("名单判定错了")
	}
}

// 当前会话落在凭据文件里，缺键 / 坏值一律回落 main。
func TestCurrentSessionPersistsInCredential(t *testing.T) {
	_, path := sessionApp(t)
	if got := currentSessionFrom(path); got != "main" {
		t.Fatalf("缺键应回落 main，实际 %q", got)
	}
	if err := saveCurrentSession(path, "work"); err != nil {
		t.Fatal(err)
	}
	saved, ok := loadCredential(path)
	if !ok || saved.Session != "work" || saved.Token != "secret" || saved.Base != "http://127.0.0.1:1" {
		t.Fatalf("写会话把凭据改坏了：%+v, %v", saved, ok)
	}
	if got := currentSessionFrom(path); got != "work" {
		t.Errorf("下次启动应恢复 work，实际 %q", got)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("写会话后权限没守住：%+v, %v", info, err)
	}
	// 老文件 / 坏值：不把非法 id 拼进 query。
	if err := os.WriteFile(path, []byte(`{"deviceId":"d","token":"t","base":"http://x","session":"Bad_ID"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentSessionFrom(path); got != "main" {
		t.Errorf("坏值应回落 main，实际 %q", got)
	}
	if err := saveCurrentSession(path, "Bad_ID"); !errors.Is(err, ErrInvalidSessionID) {
		t.Errorf("写非法会话名应本地拒绝，实际 %v", err)
	}
}

// 左栏：能力位齐备才画会话列表；老后端只留那句实话，不画切换条、不给新建入口。
func sessionPaneIn(s *app) *ui.Tester {
	p := PaletteFor(false)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Width(329).FillHeight().PaddingX(14).PaddingY(22).Background(p.Card).Children(func() {
			s.sessionPane(c, p)
		})
	}, 329, 480)
	tt.Frame()
	return tt
}

func TestSessionPaneListsAndSwitches(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.currentSession = defaultSessionID
	s.conversations["main"] = &Conversation{SessionID: "main"}
	s.conversation = s.conversations["main"]

	tt := sessionPaneIn(s)
	if !tt.HasText("main") || !tt.HasText("work") || !tt.HasText("新建") {
		t.Fatalf("会话列表没画出来：%v", tt.Texts())
	}
	if err := tt.Click("work"); err != nil {
		t.Fatalf("点会话没接上：%v", err)
	}
	tt.Frame()
	if s.currentSession != "work" {
		t.Errorf("点了 work 却还停在 %q", s.currentSession)
	}
}

func TestSessionPaneLocksMainOnLegacyBackend(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, false
	s.currentSession = defaultSessionID
	s.sessionNote = legacySessionNote

	tt := sessionPaneIn(s)
	if !tt.HasText(legacySessionNote) {
		t.Errorf("老后端没有如实提示：%v", tt.Texts())
	}
	if tt.HasText("新建") || tt.HasText("新会话名") {
		t.Errorf("老后端不该画切换条/新建入口：%v", tt.Texts())
	}
	if s.switchSession("work") {
		t.Error("老后端竟然允许切到 work")
	}
	if s.currentSession != "main" || s.sessionNote != legacySessionNote {
		t.Errorf("老后端没锁住 main：session=%q note=%q", s.currentSession, s.sessionNote)
	}
}

// 切换时上一段的时间线还在路上：新会话不能被那个全局「在途」标记饿住，
// 同一段会话的重复刷新仍然要挡住。
func TestSwitchWhileRefreshInFlightStillLoadsTheNewSession(t *testing.T) {
	_, log, client := sessionCapableFixture(t)
	s, _ := sessionApp(t)
	s.client = client
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.currentSession = defaultSessionID
	s.conversations["main"] = &Conversation{SessionID: "main"}

	// 同一段在途：不重复发。
	s.refreshing, s.refreshingSession = true, "main"
	before := log.count()
	s.refresh()
	if got := log.count(); got != before {
		t.Errorf("同一会话在途时重复发了刷新：%v", log.all())
	}

	if !s.switchSession("work") {
		t.Fatal("切到 work 没成功")
	}
	waitForSessionCall(t, log, "/api/mobile/timeline?session_id=work")
}

// 门禁在传输层，不靠 UI 记得查 sessionsChecked：先验没确认时，
// 就算 Client 已经指向 work，任何非 main 请求也一个都发不出去。
func TestNonMainRequestsAreBlockedUntilCapabilityIsConfirmed(t *testing.T) {
	server, log := sessionFixture(t, emptyReply)
	unconfirmed := New(server.URL, "secret", "").WithSession("work")
	if _, err := unconfirmed.Timeline(context.Background()); !errors.Is(err, ErrSessionsUnavailable) {
		t.Errorf("先验未过却放行了非 main 请求：%v", err)
	}
	if got := log.count(); got != 0 {
		t.Errorf("先验未过却发了 %d 个请求：%v", got, log.all())
	}
	_, log2, confirmed := sessionCapableFixture(t)
	if _, err := confirmed.WithSession("work").Timeline(context.Background()); err != nil {
		t.Fatalf("先验过了却发不出去：%v", err)
	}
	if got := log2.last().url; got != "/api/mobile/timeline?session_id=work" {
		t.Errorf("先验后打到了 %q", got)
	}
}

// POST 200 但缺能力位：名单按 sessions[] 刷新，仍锁 main 并如实说，
// 不把「200」翻成「新建失败」，也不静默切到非 main。
func TestCreateSessionWithoutCapabilityBitLocksMain(t *testing.T) {
	server, log := sessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"work","sessions":["main","work"]}`))
	})
	view, err := New(server.URL, "secret", "").CreateSession(context.Background(), "work")
	if err != nil || view == nil || view.SessionAPI != 0 || len(view.Sessions) != 2 {
		t.Fatalf("POST 200 不该按失败处理：view=%+v err=%v", view, err)
	}
	log.reset()
	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "")
	s.sessionsChecked, s.sessionBusy = true, true
	s.sessions = []string{"main"}
	s.sessionDraft = "work"
	s.applyCreatedSession(createdSessionResult{view: view, id: "work"})
	if s.sessionAPI || s.currentSession != "main" || s.sessionNote != legacySessionNote {
		t.Errorf("缺能力位应锁 main 并如实说：api=%v session=%q note=%q", s.sessionAPI, s.currentSession, s.sessionNote)
	}
	if len(s.sessions) != 2 || s.sessions[1] != "work" {
		t.Errorf("POST 的 sessions[] 没刷新：%v", s.sessions)
	}
	for _, call := range log.all() {
		if strings.Contains(call.url, "session_id") {
			t.Errorf("锁 main 之后仍发了非 main 请求：%s", call.url)
		}
	}
}

// 会话状态由 newApp 一次建好，不靠调用方塞默认值兜底。
func TestSessionChannelsAreWiredInNewApp(t *testing.T) {
	s := newApp(nil)
	if s.conversations == nil || s.sessionsCh == nil || s.createdSessionCh == nil {
		t.Fatal("newApp 没把会话缓存/结果通道建好")
	}
	if s.currentSession != defaultSessionID {
		t.Errorf("缺省会话 = %q，应为 main", s.currentSession)
	}
}

// 在途刷新用的客户端在发起那一刻锁定：A 的 timeline 回来后，
// 已读上报仍落在 A 的 main，不会跟着主线程的切换跑到 B。
func TestInFlightRefreshKeepsItsOwnSession(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release) // 断言提前失败也别让 handler 卡住 server.Close()
		}
	})
	var once sync.Once
	server, log := sessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mobile/timeline" && r.URL.RawQuery == "" {
			once.Do(func() { <-release })
			_, _ = w.Write([]byte(`{"items":[{"id":"a1","role":"agent","text":"答","at":"2026-11-13T00:00:00Z"}],
			  "bots":[],"tasks":[],"session_id":"main","session_api":1}`))
			return
		}
		emptyReply(w, r)
	})
	client := New(server.URL, "secret", "")
	client.confirmSessions()
	s, _ := sessionApp(t)
	s.client = client
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.currentSession = defaultSessionID
	s.conversations["main"] = &Conversation{SessionID: "main"}

	s.refresh()
	waitForSessionCall(t, log, "/api/mobile/timeline")
	if !s.switchSession("work") {
		t.Fatal("切到 work 没成功")
	}
	waitForSessionCall(t, log, "/api/mobile/timeline?session_id=work")
	close(release)
	waitForSessionCall(t, log, "/api/mobile/read")
	for _, call := range log.all() {
		if strings.Contains(call.url, "/api/mobile/read?session_id=work") {
			t.Errorf("A 的已读上报串到了 B：%s", call.url)
		}
	}
}
