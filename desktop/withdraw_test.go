package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 撤回要按后端契约发：POST /api/mobile/withdraw，body 里是 request_id。
func TestWithdrawPostsTheRequestID(t *testing.T) {
	var path, device, credential string
	var body struct {
		RequestID string `json:"request_id"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		device = r.Header.Get("x-crew-device")
		credential = r.Header.Get("x-crew-credential")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("撤回请求的 body 解不开：%v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	if err := New(server.URL, "secret", "dev-1").Withdraw(context.Background(), "r-1"); err != nil {
		t.Fatalf("Withdraw 返回错误：%v", err)
	}
	if path != "/api/mobile/withdraw" {
		t.Errorf("撤回打到了 %s，契约是 /api/mobile/withdraw", path)
	}
	if body.RequestID != "r-1" {
		t.Errorf("body 里的 request_id 是 %q，应该是 r-1", body.RequestID)
	}
	if device != "dev-1" || credential != "secret" {
		t.Errorf("撤回没带凭据：device=%q credential=%q", device, credential)
	}
}

// 409 表示已经读过/回过了，要给人一句能看懂的话，不能只说「队伍返回 409」。
func TestWithdrawExplainsAnAlreadyReadMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
	}))
	t.Cleanup(server.Close)

	err := New(server.URL, "secret", "").Withdraw(context.Background(), "r-1")
	if err == nil {
		t.Fatal("409 时 Withdraw 没有报错")
	}
	if !strings.Contains(err.Error(), "已经") {
		t.Errorf("409 的说法是 %q，没有说清「已经读过了」", err.Error())
	}
}

// 时间线里按 request_id 对回正文：排队的是请求号，摘要要人看得懂。
func TestQueuedPreviewsFindTheText(t *testing.T) {
	conversation := &Conversation{
		Queued: []string{"r-1", "r-2", "r-3", "r-4"},
		Messages: []Message{
			{RequestID: "r-1", Text: "第一句"},
			{RequestID: "r-2", Text: "第二句"},
			{RequestID: "r-3", Text: "第三句"},
			// r-4 还没读回来：摘要留空，由 queuedSummary 说实话。
		},
	}
	got := queuedPreviews(conversation, 3)
	if len(got) != 3 {
		t.Fatalf("取了 %d 条预览，想要最近 3 条", len(got))
	}
	if got[0].RequestID != "r-2" || got[1].RequestID != "r-3" || got[2].RequestID != "r-4" {
		t.Errorf("取到的是 %+v，想要最近三条 r-2/r-3/r-4", got)
	}
	if got[0].Text != "第二句" {
		t.Errorf("r-2 的正文是 %q，应该是「第二句」", got[0].Text)
	}
	if summary := queuedSummary(got[2].Text, queuedPreviewRunes); summary == "" || !strings.Contains(summary, "还没读回来") {
		t.Errorf("对不上正文时摘要说 %q，应该明说还没读回来", summary)
	}
}

// waitFor 让 Tester 继续出帧，直到条件成立或超时。撤回结果走的是后台 goroutine。
func waitFor(t *testing.T, tt *ui.Tester, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		tt.Frame()
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等不到：%s", what)
}

// 有排队时，输入框上方要列出摘要和「撤回」；点它真的打到 Withdraw。
func TestQueuedMessageHasAWithdrawButton(t *testing.T) {
	withdrawn := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case withdrawPath:
			var body struct {
				RequestID string `json:"request_id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			withdrawn <- body.RequestID
			w.WriteHeader(http.StatusOK)
		case "/api/mobile/timeline":
			// 撤回成功后会重读一次时间线；给一个空对话，别让它变成断连。
			_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[],"status":{"runtime":"ready"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = &Conversation{
		Bots:   []BotCard{{ID: "lead", Name: "大哥"}},
		Queued: []string{"r-1"},
		Messages: []Message{
			{ID: "m1", Role: "user", RequestID: "r-1", Text: "帮我看下首页"},
		},
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	if !tt.HasText("帮我看下首页") {
		t.Fatalf("排队消息的摘要没画出来；画的是 %v", tt.Texts())
	}
	rect, ok := tt.Find("撤回")
	if !ok {
		t.Fatalf("排队时找不到「撤回」按钮；画的是 %v", tt.Texts())
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)

	select {
	case id := <-withdrawn:
		if id != "r-1" {
			t.Errorf("撤回的是 %q，应该点哪条撤哪条（r-1）", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("点了「撤回」，请求没有打到 /api/mobile/withdraw")
	}
	waitFor(t, tt, "撤回结果回到界面", func() bool { return len(s.withdrawing) == 0 })
	if s.problem != "" {
		t.Errorf("撤回成功却写进了全局 problem：%q", s.problem)
	}
}

// 撤回失败只写在排队那一块，不能冒充连接故障把发送锁住。
func TestAWithdrawFailureStaysLocal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == withdrawPath {
			w.WriteHeader(http.StatusConflict)
			return
		}
		// 409 之后客户端会重读时间线：给它一份正常的空时间线，这样「局部报错」与「刷新失败」分开。
		if r.URL.Path == "/api/mobile/timeline" {
			_, _ = w.Write([]byte(`{"items":[],"tasks":[],"queued":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = &Conversation{
		Queued:   []string{"r-1"},
		Messages: []Message{{ID: "m1", Role: "user", RequestID: "r-1", Text: "这条已经被读了"}},
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()
	rect, ok := tt.Find("撤回")
	if !ok {
		t.Fatalf("找不到「撤回」；画的是 %v", tt.Texts())
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)

	waitFor(t, tt, "撤回失败显示在局部", func() bool { return s.withdrawError != "" })
	if !tt.HasText("撤回没成功") {
		t.Errorf("撤回失败没有在排队那一块说明；画的是 %v", tt.Texts())
	}
	if s.problem != "" {
		t.Errorf("撤回失败写进了全局 problem：%q", s.problem)
	}
}
