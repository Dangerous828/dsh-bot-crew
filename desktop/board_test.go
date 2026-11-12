package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// 事务板的四组口径：三组工单只按 Open / NeedsPerson 判，
// 第一组是 Queued 请求号反查回来的原话，不是 Task。
func TestBoardGroupsSplitByBackendFields(t *testing.T) {
	conversation := &Conversation{
		Messages: []Message{
			{ID: "m1", Role: "user", RequestID: "q1", Text: "今天天气怎么样"},
			{ID: "m2", Role: "agent", Text: "晴"},
			{ID: "m3", Role: "user", RequestID: "q3", Text: "写个 ok.txt"},
		},
		// q-missing 在 items 里对不上正文：不许编一条出来。
		Queued: []string{"q1", "q3", "q-missing"},
		Tasks: []Task{
			{ID: "t1", Title: "在跑的活", Open: true, BotID: "coder", TotalSteps: 4, StepsDone: 2},
			{ID: "t2", Title: "等你拍板", Open: true, NeedsPerson: "review"},
			{ID: "t3", Title: "办完的活", Open: false, BotID: "writer"},
		},
	}
	queued, running, waiting, done := boardGroups(conversation)

	if len(queued) != 2 || queued[0].RequestID != "q1" || queued[0].Text != "今天天气怎么样" || queued[1].Text != "写个 ok.txt" {
		t.Fatalf("还没回的话应是两条反查得到的原话，实际 %+v", queued)
	}
	if len(running) != 1 || running[0].ID != "t1" {
		t.Fatalf("在跑应是 t1，实际 %+v", running)
	}
	if len(waiting) != 1 || waiting[0].ID != "t2" {
		t.Fatalf("等你拍板应是 t2，实际 %+v", waiting)
	}
	if len(done) != 1 || done[0].ID != "t3" {
		t.Fatalf("办完应是 t3，实际 %+v", done)
	}

	// 没读到时间线：四组都空，不许拿上一帧的东西凑数。
	if q, r, w, d := boardGroups(nil); len(q)+len(r)+len(w)+len(d) != 0 {
		t.Fatal("没有时间线时不该分出任何组")
	}
	// 读得到、确实一条都没有：也是四组都空。
	if q, r, w, d := boardGroups(&Conversation{}); len(q)+len(r)+len(w)+len(d) != 0 {
		t.Fatal("空时间线不该分出假条目")
	}
}

// 进度条口径：没有计划（TotalSteps<=0）就返回 (0,0)；分子夹在 [0,TotalSteps]。
func TestBoardProgressOnlyDrawsWithAPlan(t *testing.T) {
	s := &app{}
	if done, total := s.progressOf(Task{}); done != 0 || total != 0 {
		t.Fatalf("没有计划应是 (0,0)，实际 (%d,%d)", done, total)
	}
	if done, total := s.progressOf(Task{TotalSteps: 4, StepsDone: 2}); done != 2 || total != 4 {
		t.Fatalf("有计划应是 (2,4)，实际 (%d,%d)", done, total)
	}
	if done, total := s.progressOf(Task{TotalSteps: 4, StepsDone: 9}); done != 4 || total != 4 {
		t.Fatalf("自相矛盾的计划要夹在上界，实际 (%d,%d)", done, total)
	}
	if done, total := s.progressOf(Task{TotalSteps: 4, StepsDone: -3}); done != 0 || total != 4 {
		t.Fatalf("负数要夹在下界，实际 (%d,%d)", done, total)
	}
}

func boardPaneIn(s *app) *ui.Tester {
	p := PaletteFor(false)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Width(393).FillHeight().PaddingX(16).PaddingY(22).Background(p.Surface).Children(func() {
			s.boardPane(c, p)
		})
	}, 393, 500)
	tt.Frame()
	return tt
}

// 「读不到」「还没读到」「确实没有」是三句话，不能互相顶替。
func TestBoardEmptyAndUnavailableSayDifferentThings(t *testing.T) {
	s := &app{}
	if tt := boardPaneIn(s); !tt.HasText("正在读事务…") || tt.HasText("还没有事务") {
		t.Fatalf("还没读到时间线时该说「正在读事务…」，画的是 %v", tt.Texts())
	}
	s.problem = "连不上"
	if tt := boardPaneIn(s); !tt.HasText("还没连上，读不到事务") || tt.HasText("正在读事务…") {
		t.Fatalf("连接故障时该说读不到，画的是 %v", tt.Texts())
	}
	s.problem = ""
	s.conversation = &Conversation{}
	if tt := boardPaneIn(s); !tt.HasText("还没有事务") || tt.HasText("读不到") {
		t.Fatalf("读得到且确实为空该说「还没有事务」，画的是 %v", tt.Texts())
	}
}

// 有数据时四组标题都在；空组整组不画（不摆一个写着 0 的空标题）。
func TestBoardDrawsOnlyNonEmptyGroups(t *testing.T) {
	s := &app{}
	s.conversation = &Conversation{
		Tasks: []Task{{ID: "t1", Title: "在跑的活", Open: true, BotID: "coder"}},
	}
	tt := boardPaneIn(s)
	if !tt.HasText("在跑") || !tt.HasText("在跑的活") {
		t.Fatalf("在跑这一组该出现，画的是 %v", tt.Texts())
	}
	for _, absent := range []string{"还没回的话", "等你拍板", "办完", "还没有事务"} {
		if tt.HasText(absent) {
			t.Errorf("空组 %q 不该画出来，画的是 %v", absent, tt.Texts())
		}
	}
}

// 分拣台三段：收件筐只取最近的人话，大哥在分只收等你拍板 / 刚派的，
// 各人的活儿按 BotID 分堆；没有 BotID 的票不编一个人出来接。
func TestTriageGroupsComeFromTheSameTimeline(t *testing.T) {
	conversation := &Conversation{
		Messages: []Message{
			{ID: "m1", Role: "user", Text: "第一句"},
			{ID: "m2", Role: "agent", Text: "收到"},
			{ID: "m3", Role: "user", Text: "第二句"},
			{ID: "m4", Role: "user", Text: "第三句"},
		},
		Tasks: []Task{
			{ID: "t1", Title: "派给码农", Open: true, BotID: "coder"},
			{ID: "t2", Title: "等拍板", Open: true, NeedsPerson: "review", BotID: "lead"},
			{ID: "t3", Title: "办完了", Open: false, BotID: "coder"},
			{ID: "t4", Title: "还没派", Open: true},
		},
	}
	inbox, sorting, piles := triageGroups(conversation, 2)
	if len(inbox) != 2 || inbox[0].Text != "第三句" || inbox[1].Text != "第二句" {
		t.Fatalf("收件筐应是最近两句人话、最新在最上，实际 %+v", inbox)
	}
	if len(sorting) != 2 || sorting[0].ID != "t1" || sorting[1].ID != "t2" {
		t.Fatalf("大哥在分应是刚派的与等你拍板两张，实际 %+v", sorting)
	}
	if len(piles) != 2 || piles[0].BotID != "coder" || len(piles[0].Tasks) != 2 || piles[1].BotID != "lead" {
		t.Fatalf("各人的活儿应按 BotID 分两堆，实际 %+v", piles)
	}
	if got := triageCountLine(conversation); got != "收进 3 · 在跑 2 · 等你拍板 1 · 办完 1" {
		t.Fatalf("底部计数带要现算，实际 %q", got)
	}
	if a, b, c := triageGroups(nil, 5); len(a)+len(b)+len(c) != 0 {
		t.Fatal("没有时间线时不该摆假纸条")
	}
}
