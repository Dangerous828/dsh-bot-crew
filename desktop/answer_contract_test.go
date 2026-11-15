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

// 这一组钉住「审批答复走审批通道」这条契约（task-12）：
// 带 attention_id 的票，点选项 / 自写一句都必须打到 POST /api/mobile/answer，
// body 只带必要三项（ticket/text/attention_id），绝不拼 @文本发 /send；
// 旧卡过期（409）刷新时间线换成最新一张卡并明说「已更新」，不冒充成功、也不当断连。
// 老后端没下发 attention_id 的票保持既有 /send 行为，逐字不变。

// approvalTicket 是带 attention_id 的待决卡（新后端）。
const approvalTicket = `{"id":"tk-1","title":"改首页","state":"waiting","open":true,"bot_id":"lin",` +
	`"needs_person":"answer","question":"首页先改哪一块？","attention_id":"attention-approval-tk-1",` +
	`"options":[{"id":"opt-a","label":"去改首页"},{"id":"opt-b","label":"先放着"}]}`

func approvalConversation(t *testing.T) *Conversation {
	return &Conversation{
		Bots:     []BotCard{{ID: "lin", Name: "林", Persona: "前端，先看现有约定。"}},
		Messages: []Message{{ID: "m1", Role: "agent", BotID: "lin", At: "2026-11-11T10:00:00Z", Text: "首页我看了"}},
		Tasks:    []Task{taskFromJSON(t, approvalTicket)},
	}
}

// TestAnswerGoesThroughTheApprovalEndpoint：带 attention_id 的票点选项，打到 /answer 而不是 /send，
// body 是 {ticket,text,attention_id}；服务端 200 后重读时间线。
func TestAnswerGoesThroughTheApprovalEndpoint(t *testing.T) {
	answered := make(chan map[string]string, 4)
	var sentHits, answerHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/answer":
			atomic.AddInt32(&answerHits, 1)
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			answered <- body
			_, _ = w.Write([]byte(`{"ok":true,"answer":"go","ticket":"tk-1","attention_id":"attention-approval-tk-1"}`))
		case "/api/mobile/send":
			atomic.AddInt32(&sentHits, 1)
			_, _ = w.Write([]byte(`{"ok":true,"id":"x","request_id":"r"}`))
		case "/api/mobile/timeline":
			_, _ = w.Write([]byte(timelineWith(approvalTicket)))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = approvalConversation(t)
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	rect, ok := tt.Find("去改首页")
	if !ok {
		t.Fatalf("找不到选项「去改首页」；画的是 %v", tt.Texts())
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()

	select {
	case body := <-answered:
		if body["ticket"] != "tk-1" {
			t.Errorf("ticket 是 %q，应为 tk-1", body["ticket"])
		}
		if body["attention_id"] != "attention-approval-tk-1" {
			t.Errorf("attention_id 是 %q，应为那张卡的 id", body["attention_id"])
		}
		// text 传的是选项 label（后端 label/id 都认），不是 @某人 前缀后的整句。
		if body["text"] != "去改首页" {
			t.Errorf("text 是 %q，应只传选项 label「去改首页」", body["text"])
		}
		if _, has := body["actor"]; has {
			t.Errorf("body 里出现了 actor：身份只能由服务端认证，客户端不发可伪造身份")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("点选项没有打到 /api/mobile/answer")
	}
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt32(&sentHits); got != 0 {
		t.Errorf("审批答复走了 %d 次 /send，应该一次都不走", got)
	}
	if s.problem != "" {
		t.Errorf("答了一句却写进了全局 problem（断连横幅）：%q", s.problem)
	}
}

// TestStaleAnswerRefreshesWithoutPretending：后端 409（旧卡过期）时，不当成功也不当断连；
// 刷新时间线换成最新一张卡，并在卡上说「已更新」。
func TestStaleAnswerRefreshesWithoutPretending(t *testing.T) {
	var timelineHits int32
	// 刷新后回到的是一张新卡（同一张票换了问题 + 新 attention_id）。
	const refreshed = `{"id":"tk-1","title":"改首页","state":"waiting","open":true,"bot_id":"lin",` +
		`"needs_person":"answer","question":"首页改完了，下一步做哪块？","attention_id":"attention-approval-tk-1-v2",` +
		`"options":[{"id":"opt-c","label":"做登录"}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/answer":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"这张问题卡已经过期（票或请求已变），请刷新后再答"}`))
		case "/api/mobile/timeline":
			atomic.AddInt32(&timelineHits, 1)
			_, _ = w.Write([]byte(timelineWith(refreshed)))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = approvalConversation(t)
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	rect, ok := tt.Find("去改首页")
	if !ok {
		t.Fatalf("找不到选项「去改首页」；画的是 %v", tt.Texts())
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()

	// 等到刷新把新卡换上来。
	waitFor(t, tt, "409 之后刷新换成最新一张卡", func() bool {
		return tt.HasText("首页改完了，下一步做哪块？")
	})
	if atomic.LoadInt32(&timelineHits) == 0 {
		t.Error("409 之后没有重读时间线：旧卡不会自己更新")
	}
	if s.problem != "" {
		t.Errorf("409 被写进了全局 problem（当成断连）：%q", s.problem)
	}
	if !tt.HasText("这张问题卡已更新，请按最新的那张再答") {
		t.Errorf("409 时没有在卡上说「已更新」；画的是 %v", tt.Texts())
	}
	if tt.HasText("已按这个答了，队伍下一步会接上") {
		t.Error("409 被当成了答复成功：出现了「已按这个答了」")
	}
}

// TestTicketWithoutAttentionStillUsesSend：老后端没下发 attention_id 的卡保持既有 /send 行为。
func TestTicketWithoutAttentionStillUsesSend(t *testing.T) {
	sent := make(chan string, 4)
	var answerHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/send":
			var body struct {
				Text string `json:"text"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			sent <- body.Text
			_, _ = w.Write([]byte(`{"ok":true,"id":"x","request_id":"r"}`))
		case "/api/mobile/answer":
			atomic.AddInt32(&answerHits, 1)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/mobile/timeline":
			_, _ = w.Write([]byte(timelineWith(askedTicket))) // askedTicket 无 attention_id
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = askedConversation(t)
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	rect, ok := tt.Find("去改首页")
	if !ok {
		t.Fatalf("找不到选项「去改首页」；画的是 %v", tt.Texts())
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()

	select {
	case text := <-sent:
		if text != "@林 去改首页" {
			t.Errorf("无 attention_id 的卡应走 /send 点名那一位，发的是 %q", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("无 attention_id 的卡没有走 /send")
	}
	if atomic.LoadInt32(&answerHits) != 0 {
		t.Error("无 attention_id 的卡误走了 /answer")
	}
}

// TestReviseSendsTheTypedLineThroughAnswer：审批卡上的「自己写一句」也是 /answer，
// text 是用户原文（不是预约 @文本、也不是拼成 select 选项），带同一个 attention_id。
func TestReviseSendsTheTypedLineThroughAnswer(t *testing.T) {
	answered := make(chan map[string]string, 4)
	var sentHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/answer":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			answered <- body
			_, _ = w.Write([]byte(`{"ok":true,"answer":"revise","ticket":"tk-1","attention_id":"attention-approval-tk-1"}`))
		case "/api/mobile/send":
			atomic.AddInt32(&sentHits, 1)
			_, _ = w.Write([]byte(`{"ok":true,"id":"x","request_id":"r"}`))
		case "/api/mobile/timeline":
			_, _ = w.Write([]byte(timelineWith(approvalTicket)))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = approvalConversation(t)
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	task := s.conversation.Tasks[0]
	if task.AttentionID != "attention-approval-tk-1" {
		t.Fatalf("测试票没有 attention_id：%q", task.AttentionID)
	}
	// 审批卡走内联自写格分支：画面上只留一个「回」，没有普通 prefill 那句占位
	// （ui.TextInput 的 placeholder 不进 Texts，用「没有 prefill 占位」来区分两条分支）。
	if tt.HasText("自己写一句…") {
		t.Fatalf("审批卡错走了普通 prefill 分支；画的是 %v", tt.Texts())
	}
	// 直写草稿再发：断言走 /answer、带原文与 attention_id。
	if s.answerRevise == nil {
		s.answerRevise = make(map[string]*reviseDraft)
	}
	s.answerRevise[task.ID] = &reviseDraft{Text: "换个做法：先做登录"}
	s.sendRevise(task)

	select {
	case body := <-answered:
		if body["text"] != "换个做法：先做登录" {
			t.Errorf("revise 的 text 是 %q，应为用户原文", body["text"])
		}
		if body["attention_id"] != "attention-approval-tk-1" {
			t.Errorf("revise 漏了 attention_id：%q", body["attention_id"])
		}
		if body["ticket"] != "tk-1" {
			t.Errorf("revise 的 ticket 是 %q", body["ticket"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("自写一句没有打到 /api/mobile/answer")
	}
	if atomic.LoadInt32(&sentHits) != 0 {
		t.Error("自写一句误走了 /send")
	}
}
