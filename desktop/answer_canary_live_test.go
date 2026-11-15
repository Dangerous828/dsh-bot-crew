package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 真机/真后端的端到端实证：跑桌面**真实** Client + 真实 view 渲染 + 真实 OnClick，
// 打到 backend owner 起的隔离 canary（不是 httptest）。只在 CREW_CANARY 设了才跑，
// 平时 `go test ./...` 会跳过 —— 这不是假 UI，是真实组件、真 HTTP。
//
// 用法：
//   CREW_CANARY=http://127.0.0.1:8799 \
//   CREW_CANARY_TICKET=canary-answer-1 \
//   CREW_CANARY_CLICK=先别做 \
//   go test -run TestLiveCanaryAnswerClick -count=1 -v .
func TestLiveCanaryAnswerClick(t *testing.T) {
	base := os.Getenv("CREW_CANARY")
	if base == "" {
		t.Skip("未设 CREW_CANARY：跳过真后端实证（这是隔离 canary 专用）")
	}
	ticketID := os.Getenv("CREW_CANARY_TICKET")
	clickLabel := os.Getenv("CREW_CANARY_CLICK")
	if ticketID == "" || clickLabel == "" {
		t.Skip("需要 CREW_CANARY_TICKET / CREW_CANARY_CLICK")
	}

	s := newApp(New(base, "secret", ""))
	// 拉真实时间线：走的就是产品那条 GET /api/mobile/timeline。
	conv, err := s.client.Timeline(context.Background())
	if err != nil {
		t.Fatalf("拉 canary 时间线失败：%v", err)
	}
	s.conversation = conv

	var target *Task
	for i := range conv.Tasks {
		if conv.Tasks[i].ID == ticketID {
			target = &conv.Tasks[i]
			break
		}
	}
	if target == nil {
		t.Fatalf("canary 时间线里没有票 %s", ticketID)
	}
	if target.AttentionID == "" {
		t.Fatalf("票 %s 没下发 attention_id：客户端无法走 /answer", ticketID)
	}
	t.Logf("票 %s attention_id=%s options=%v", target.ID, target.AttentionID, target.Options)

	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1400, 900)
	tt.Frame()
	if !tt.HasText(clickLabel) {
		t.Fatalf("卡上没画选项「%s」；画的是 %v", clickLabel, tt.Texts())
	}
	rect, ok := tt.Find(clickLabel)
	if !ok {
		t.Fatalf("找不到选项「%s」的点击区", clickLabel)
	}
	// 真实 OnClick → 真实 Client.Answer → 真实 /api/mobile/answer。
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()

	// 等 answered 通道把结果收进来（refresh 会再拉一次时间线）。
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if s.answerNote != "" {
			break
		}
		tt.Frame()
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("点击后 answerNote=%q stale=%v problem=%q", s.answerNote, s.answerStale, s.problem)
	// 真后端回来的另一种确认：再拉一次时间线，看这张票是否已经离开 waiting。
	after, err := s.client.Timeline(context.Background())
	if err != nil {
		t.Fatalf("复拉时间线失败：%v", err)
	}
	for _, tk := range after.Tasks {
		if tk.ID == ticketID {
			t.Logf("复拉：票 %s state=%s open=%v needs=%s", tk.ID, tk.State, tk.Open, tk.NeedsPerson)
		}
	}
}
