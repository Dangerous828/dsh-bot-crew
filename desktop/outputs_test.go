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

// ticketRefOf 把票号塞进 Extra —— ticketRef 读的就是这里，测试也跟着走同一条路。
func ticketRefOf(ref string) map[string]json.RawMessage {
	quoted, _ := json.Marshal(ref)
	return map[string]json.RawMessage{"ticket_ref": quoted}
}

// 同一张票的票号会挂在「收到」和「报结果」两条回复上：只让最后一条挂结果条。
// 判据是纯函数 lastOfTicket，这里把它几条边界一次钉死。
func TestOnlyTheLastMessageOfATicketShowsTheBar(t *testing.T) {
	// 按时间线顺序排：先「收到」，干完再「报结果」—— 两条都带 tk-1。
	messages := []Message{
		{Role: "agent", Text: "收到，这就去改"},
		{Role: "agent", Text: "开始改了", Extra: ticketRefOf("tk-1")},
		{Role: "agent", Text: "改好了", Extra: ticketRefOf("tk-1")},
	}
	if lastOfTicket(messages, 1) {
		t.Fatal("前面的同票号回复不该挂结果条：屏幕上会连着两条同一句话")
	}
	if !lastOfTicket(messages, 2) {
		t.Fatal("最后一条带 tk-1 的回复才该挂结果条")
	}
	// 没有票号的那一条永远不挂 —— 绝不因为「前后都没票号」就替它认一张票。
	if lastOfTicket(messages, 0) {
		t.Fatal("没票号的消息不该挂结果条")
	}
}

func TestLastOfTicketCountsOnlyBotReplies(t *testing.T) {
	// 自己发的话不挂结果条，所以它带同票号也不算「压住上面那条回复」。
	messages := []Message{
		{Role: "agent", Text: "改好了", Extra: ticketRefOf("tk-2")},
		{Role: "user", Text: "@coder 再看看", Extra: ticketRefOf("tk-2")},
	}
	if !lastOfTicket(messages, 0) {
		t.Fatal("后面只有人说的话时，Bot 那条仍是这张票的最后一条回复")
	}
	// 反过来：人说的那条无论后面有没有同票号的回复，都不挂。
	if lastOfTicket(messages, 1) {
		t.Fatal("自己发的话不挂结果条")
	}
}

func TestLastOfTicketKeepsTicketsApartAndForgivesBadIndex(t *testing.T) {
	// 两张票各论各的：tk-3 后面来了 tk-4，不影响 tk-3 那条仍是它自己的最后一条。
	messages := []Message{
		{Role: "agent", Text: "tk-3 收到", Extra: ticketRefOf("tk-3")},
		{Role: "agent", Text: "tk-4 收到", Extra: ticketRefOf("tk-4")},
	}
	if !lastOfTicket(messages, 0) || !lastOfTicket(messages, 1) {
		t.Fatal("不同票号互不压盖：两条都是各自票号的最后一条")
	}
	// 只有一条、带票号：它就是最后一条。
	if !lastOfTicket(messages[:1], 0) {
		t.Fatal("独生子该挂结果条")
	}
	// 越界的下标返回 false，别让调用方一处写错就炸掉整屏。
	if lastOfTicket(messages, 2) || lastOfTicket(messages, -1) || lastOfTicket(nil, 0) {
		t.Fatal("越界下标该安静地不画")
	}
	// 空白票号算没带，与 ticketRef 的规矩一致。
	blank := []Message{{Role: "agent", Text: "x", Extra: ticketRefOf("  ")}}
	if lastOfTicket(blank, 0) {
		t.Fatal("空白票号不算票号")
	}
}

