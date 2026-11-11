package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 产出那一栏读的是后端的 `GET /api/mobile/outputs`（契约 §5.4）。
// 三种 state 分得开不开，是这一栏的全部分寸：读不到不能说成没有。
func serveOutputs(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-crew-credential"); got != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/api/mobile/outputs" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestOutputsReadWhatTheCrewHandedOver(t *testing.T) {
	server := serveOutputs(t, `{
	  "items": [
	    {"id": "tk1|shots/375.png", "ticket_id": "tk1", "ticket_title": "调开登录页间距", "bot_id": "coder",
	     "kind": "image", "path": "shots/375.png", "cwd": "/work/tk1", "title": "375.png", "writes": 1,
	     "at": "2026-11-11T10:05:00.000Z"},
	    {"id": "tk1|src/login.tsx", "ticket_id": "tk1", "ticket_title": "调开登录页间距", "kind": "file",
	     "path": "src/login.tsx", "title": "login.tsx", "writes": 2, "at": "2026-11-11T10:03:00.000Z"}
	  ],
	  "state": "live",
	  "counts": {"file": 1, "image": 1}
	}`)
	client := New(server.URL, "secret", "")

	view, err := client.Outputs(context.Background(), "")
	if err != nil {
		t.Fatalf("Outputs returned an error: %v", err)
	}
	if view.State != "live" || len(view.Items) != 2 {
		t.Fatalf("state=%q items=%d", view.State, len(view.Items))
	}
	if view.Items[0].Path != "shots/375.png" || view.Items[0].Kind != "image" {
		t.Errorf("first item = %+v, want the screenshot", view.Items[0])
	}
	if view.Counts.File != 1 || view.Counts.Image != 1 {
		t.Errorf("counts = %+v", view.Counts)
	}
	// 没有 bot_id 的那条不该被解成一个空串以外的东西；这里只确认它不报错。
	if view.Items[1].BotID != "" {
		t.Errorf("second item has bot %q", view.Items[1].BotID)
	}
}

func TestOutputsAskForOneTicketWhenGivenOne(t *testing.T) {
	var asked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Query().Get("ticket")
		_, _ = w.Write([]byte(`{"items":[],"state":"empty","counts":{"file":0,"image":0},"reason":"这些工单里还没有文件改动"}`))
	}))
	t.Cleanup(server.Close)

	view, err := New(server.URL, "", "").Outputs(context.Background(), "tk-9")
	if err != nil {
		t.Fatalf("Outputs returned an error: %v", err)
	}
	if asked != "tk-9" {
		t.Fatalf("问了 %q 的产出，要的是 tk-9", asked)
	}
	if view.State != "empty" || view.Reason == "" {
		t.Fatalf("空态要带一句理由，拿到 %+v", view)
	}
}

func TestOutputsKeepUnreadableApartFromEmpty(t *testing.T) {
	// 「读不到」和「没有」是两句话：前者的 reason 不能长得像空态那样。
	server := serveOutputs(t, `{"items":[],"state":"unavailable","counts":{"file":0,"image":0},"reason":"这张工单的执行记录读不出来了"}`)
	view, err := New(server.URL, "secret", "").Outputs(context.Background(), "tk1")
	if err != nil {
		t.Fatalf("Outputs returned an error: %v", err)
	}
	if view.State != "unavailable" {
		t.Fatalf("state = %q", view.State)
	}
	if outputResultLine(*view) != "" {
		t.Fatalf("读不到的时候不该有结果条，拿到 %q", outputResultLine(*view))
	}
}

func TestResultBarCountsImagesAndFilesApart(t *testing.T) {
	cases := []struct {
		counts OutputCounts
		want   string
	}{
		{OutputCounts{File: 0, Image: 2}, "2 张图片已放进产出"},
		{OutputCounts{File: 3, Image: 0}, "3 个文件已放进产出"},
		{OutputCounts{File: 1, Image: 2}, "1 个文件 · 2 张图片已放进产出"},
		// 一条都没有就不画：结果条只在有事发生时出现。
		{OutputCounts{File: 0, Image: 0}, ""},
	}
	for _, c := range cases {
		got := outputResultLine(OutputsView{Items: []OutputItem{{ID: "x"}}, State: "live", Counts: c.counts})
		if got != c.want {
			t.Fatalf("%+v 说成了 %q，要的是 %q", c.counts, got, c.want)
		}
	}
}

func TestOnlyLiveOutputsMakeASummary(t *testing.T) {
	if got := outputSummary(OutputsView{Counts: OutputCounts{File: 2, Image: 1}}); got != "2 个文件 · 1 张图片" {
		t.Fatalf("栏头写成了 %q", got)
	}
	if got := outputSummary(OutputsView{Counts: OutputCounts{}}); got != "" {
		t.Fatalf("一条都没有时栏头该是空的，拿到 %q", got)
	}
}

// 结果条只认这条消息自己的票号：没有就什么都不画，绝不按时间猜一张。
func TestResultBarNeedsTheMessagesOwnTicketRef(t *testing.T) {
	if ref := (Message{}).ticketRef(); ref != "" {
		t.Fatalf("没有票号却读出了 %q", ref)
	}
	// 票号在 Extra 里，由 ticketRef 取出来 —— 结果条读的就是这里。
	var message Message
	if err := json.Unmarshal([]byte(`{"id":"r7","role":"agent","ticket_ref":"tk-7"}`), &message); err != nil {
		t.Fatal(err)
	}
	if message.ticketRef() != "tk-7" {
		t.Fatalf("票号读成了 %q", message.ticketRef())
	}
	// 没读过这张票之前不该凭空有产出。
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	if view := s.perTicket["tk-7"]; view != nil {
		t.Fatalf("还没读过就有了 %+v", view)
	}
}

func TestOutputChannelsAreWired(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	if s.outputsCh == nil {
		t.Fatal("outputsCh 是 nil：右栏会永远停在「正在读产出」")
	}
	if s.ticketOut == nil {
		t.Fatal("ticketOut 是 nil：结果条永远等不到结果")
	}
	if s.perTicket == nil || s.loadingTicket == nil {
		t.Fatal("产出的按票缓存没建：读不到的那张会每帧重发请求")
	}
}
