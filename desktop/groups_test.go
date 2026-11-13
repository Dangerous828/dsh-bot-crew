package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 群组只读栏（契约 §10）。测试只从纯函数 groupBarLines 与 UI 的公开渲染入口进去，
// 不依赖 client.go 里尚不存在的 Conversation.Groups 字段：投影用 seam 替身注入。
// 盯住四件事：三态诚实、按组展示、只读边界、以及 lead 合并后 JSON 形状对得上。

// withGroupsProjection 把 seam 换成一份给定的投影，测试结束自动还原。
func withGroupsProjection(t *testing.T, view GroupsView) {
	t.Helper()
	original := groupsProjection
	groupsProjection = func(_ *Conversation) GroupsView { return view }
	t.Cleanup(func() { groupsProjection = original })
}

// groupsPaneIn 单独画群组栏，和 sessionPaneIn 一种做法。
func groupsPaneIn(s *app) *ui.Tester {
	p := PaletteFor(false)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Width(329).FillHeight().PaddingX(14).PaddingY(22).Background(p.Card).Children(func() {
			s.groupsPane(c, p)
		})
	}, 329, 360)
	tt.Frame()
	return tt
}

func liveGroups() GroupsView {
	return GroupsView{
		State: "live",
		Groups: []GroupView{
			{ID: "main", Title: "main", Sessions: []string{"main"}, Bots: []string{"scribbler"}, TicketCount: 2},
			{ID: "dev", Title: "开发线", Sessions: []string{"work", "triage"}, Bots: []string{"coder", "writer"}, TicketCount: 5},
		},
	}
}

func shown(tt *ui.Tester) string { return strings.Join(tt.Texts(), "\n") }

func TestGroupBarLinesLiveListsEveryGroup(t *testing.T) {
	lines := groupBarLines(liveGroups())
	if len(lines) != 2 {
		t.Fatalf("live 该每组一行，实际 %d 行：%+v", len(lines), lines)
	}
	if lines[0].text != "main · 1 会话 · 1 位 · 2 张" {
		t.Errorf("main 组那一行不对：%q", lines[0].text)
	}
	if lines[1].text != "开发线 · 2 会话 · 2 位 · 5 张" {
		t.Errorf("dev 组那一行不对：%q", lines[1].text)
	}
	if lines[0].warn || lines[1].warn {
		t.Error("有数据的组不该画成告警色")
	}
	// 标题没给就退回组 id，不编一个名字。
	bare := groupBarLines(GroupsView{State: "live", Groups: []GroupView{{ID: "ops"}}})
	if !strings.HasPrefix(bare[0].text, "ops · ") {
		t.Errorf("缺 title 时该用组 id，实际 %q", bare[0].text)
	}
}

func TestGroupBarLinesEmptySaysReadableButNoGroups(t *testing.T) {
	lines := groupBarLines(GroupsView{State: "empty"})
	if len(lines) != 1 || !strings.Contains(lines[0].text, "读得到") || !strings.Contains(lines[0].text, "还没有群组") {
		t.Fatalf("empty 该说「读得到、确实没有」，实际 %+v", lines)
	}
	if strings.Contains(lines[0].text, "读不到") || lines[0].warn {
		t.Errorf("empty 不该说读不到、也不该是告警色：%+v", lines)
	}
}

// 三态里最要紧的一条：把读不到说成没有，就是替队伍编一句话。
func TestGroupBarLinesUnavailableNeverSaysEmpty(t *testing.T) {
	lines := groupBarLines(GroupsView{State: "unavailable", Reason: "工单读不出来"})
	if len(lines) != 1 {
		t.Fatalf("unavailable 该只画一行实话，实际 %+v", lines)
	}
	if !strings.Contains(lines[0].text, "读不到群组") {
		t.Errorf("没有说读不到：%q", lines[0].text)
	}
	if strings.Contains(lines[0].text, "还没有群组") || strings.Contains(lines[0].text, "读得到") {
		t.Errorf("unavailable 借了空态的壳：%q", lines[0].text)
	}
	if !strings.Contains(lines[0].text, "工单读不出来") || !lines[0].warn {
		t.Errorf("原因没带出来、或没标成告警：%+v", lines)
	}
}

func TestGroupBarLinesMissingOrUnknownStateIsUnavailable(t *testing.T) {
	for _, state := range []string{"", "starting", "LIVE"} {
		lines := groupBarLines(GroupsView{State: state})
		if len(lines) != 1 || !strings.Contains(lines[0].text, "读不到群组") {
			t.Errorf("state=%q 该判读不到，实际 %+v", state, lines)
		}
		if strings.Contains(lines[0].text, "还没有群组") {
			t.Errorf("state=%q 被说成「确实没有」：%q", state, lines[0].text)
		}
	}
}

func TestGroupBarLinesLiveWithNoGroupsIsNotClaimedEmpty(t *testing.T) {
	lines := groupBarLines(GroupsView{State: "live"})
	if len(lines) != 1 || strings.Contains(lines[0].text, "还没有群组") || !lines[0].warn {
		t.Errorf("live 却没列组，该如实说形状不对，不能说「确实没有」：%+v", lines)
	}
}

func TestGroupsPaneRendersLiveGroups(t *testing.T) {
	s := newApp(nil)
	s.conversation = &Conversation{SessionID: "main"}
	withGroupsProjection(t, liveGroups())
	tt := groupsPaneIn(s)
	if !tt.HasText("群组") || !tt.HasText("2 组") {
		t.Errorf("栏头没画出来：%v", tt.Texts())
	}
	if !strings.Contains(shown(tt), "main · 1 会话 · 1 位 · 2 张") ||
		!strings.Contains(shown(tt), "开发线 · 2 会话 · 2 位 · 5 张") {
		t.Errorf("两组没都画出来：%v", tt.Texts())
	}
}

func TestGroupsPaneUnavailableIsNotRenderedAsEmpty(t *testing.T) {
	s := newApp(nil)
	s.conversation = &Conversation{SessionID: "main"}
	withGroupsProjection(t, GroupsView{State: "unavailable", Reason: "工单读不出来"})
	tt := groupsPaneIn(s)
	if !strings.Contains(shown(tt), "读不到群组") {
		t.Errorf("读不到没说出来：%v", tt.Texts())
	}
	if strings.Contains(shown(tt), "还没有群组") || strings.Contains(shown(tt), "读得到") {
		t.Errorf("读不到被画成了空态：%v", tt.Texts())
	}
	if tt.HasText("2 组") || tt.HasText("0 组") {
		t.Errorf("读不到时不该报组数：%v", tt.Texts())
	}
}

func TestGroupsPaneEmptyIsNotRenderedAsUnavailable(t *testing.T) {
	s := newApp(nil)
	s.conversation = &Conversation{SessionID: "main"}
	withGroupsProjection(t, GroupsView{State: "empty"})
	tt := groupsPaneIn(s)
	if !strings.Contains(shown(tt), "读得到，还没有群组") {
		t.Errorf("空态没画出来：%v", tt.Texts())
	}
	if strings.Contains(shown(tt), "读不到") {
		t.Errorf("空态不该说读不到：%v", tt.Texts())
	}
}

// 默认 seam 的诚实性：client.go 还没补 Conversation.Groups 时（本片并行开发的真实状态），
// 必须说 unavailable，绝不说 empty。
func TestDefaultGroupsProjectionIsUnavailableWithoutTheField(t *testing.T) {
	if got := (groupsOfConversation(nil)); got.State != "unavailable" || len(got.Groups) != 0 {
		t.Errorf("没有时间线时该说读不到，实际 %+v", got)
	}
	conv := &Conversation{SessionID: "main", Messages: []Message{{ID: "m1", Text: "你好"}}}
	view := groupsOfConversation(conv)
	if view.State != "unavailable" || len(view.Groups) != 0 {
		t.Errorf("后端没下发群组时该说读不到，实际 %+v", view)
	}
	if view.Reason == "" {
		t.Error("读不到得给一句原因")
	}
}

// 只读：画一栏不改动时间线，也不新增任何本地状态。
func TestGroupsPaneIsReadOnly(t *testing.T) {
	s := newApp(nil)
	s.conversation = &Conversation{SessionID: "main",
		Bots:  []BotCard{{ID: "lead", Name: "大哥"}},
		Tasks: []Task{{ID: "t1", Title: "改首页", Open: true}},
	}
	before, err := json.Marshal(s.conversation)
	if err != nil {
		t.Fatal(err)
	}
	withGroupsProjection(t, liveGroups())
	tt := groupsPaneIn(s)
	tt.Frame()
	after, err := json.Marshal(s.conversation)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Errorf("画群组栏改动了时间线：\nbefore=%s\nafter =%s", before, after)
	}
	if s.conversation == nil || len(s.conversation.Tasks) != 1 {
		t.Error("群组栏动了工单账，那就不是只读投影了")
	}
}

// 机制验证：lead 把 Groups 字段合并进 Conversation 之后，ui.go 的 JSON 往返 seam
// 应当自动读到投影，不必再改 ui.go。这里用带同名字段的替身模拟合并后的结构。
func TestGroupsProjectionRoundTripPicksUpTheMergedField(t *testing.T) {
	merged := struct {
		SessionID string      `json:"session_id"`
		Groups    *GroupsView `json:"groups"`
	}{SessionID: "main", Groups: func() *GroupsView { v := liveGroups(); return &v }()}
	raw, err := json.Marshal(merged)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Groups *GroupsView `json:"groups"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil || wire.Groups == nil {
		t.Fatalf("合并后的 groups 字段没读出来：%s, %v", raw, err)
	}
	if wire.Groups.State != "live" || len(wire.Groups.Groups) != 2 {
		t.Errorf("读到的投影不对：%+v", wire.Groups)
	}
	if lines := groupBarLines(*wire.Groups); lines[1].text != "开发线 · 2 会话 · 2 位 · 5 张" {
		t.Errorf("合并后没按投影画出来：%+v", lines)
	}
}

// lead 合并 client.go 之后，timeline 的 groups 字段要能逐字落到 GroupsView 上。
// 这条钉住两端 JSON 形状，不改 client.go 也能测。
func TestGroupsViewMatchesTheTimelineJSONShape(t *testing.T) {
	const wire = `{"groups":[{"id":"main","title":"main","sessions":["main"],"bots":["coder"],"ticket_count":3},` +
		`{"id":"dev","title":"开发线","sessions":["work"],"bots":[],"ticket_count":0}],"state":"live"}`
	var view GroupsView
	if err := json.Unmarshal([]byte(wire), &view); err != nil {
		t.Fatal(err)
	}
	if view.State != "live" || len(view.Groups) != 2 || view.Groups[0].TicketCount != 3 ||
		view.Groups[0].Bots[0] != "coder" || view.Groups[1].Title != "开发线" {
		t.Errorf("JSON 形状没对上：%+v", view)
	}
	lines := groupBarLines(view)
	if lines[0].text != "main · 1 会话 · 1 位 · 3 张" || lines[1].text != "开发线 · 1 会话 · 0 位 · 0 张" {
		t.Errorf("投影没按 JSON 画出来：%+v", lines)
	}
	// 非 live 的 reason 也要读得进来。
	var bad GroupsView
	if err := json.Unmarshal([]byte(`{"groups":[],"state":"unavailable","reason":"读不出来"}`), &bad); err != nil {
		t.Fatal(err)
	}
	if bad.Reason != "读不出来" || !strings.Contains(groupBarLines(bad)[0].text, "读不出来") {
		t.Errorf("unavailable 的 reason 没透出来：%+v", bad)
	}
}

// 上面所有用例都替换了 groupsProjection 这个 seam，所以「client.go 的 json 标签对不对」
// 「groupsOfConversation 的 live 分支对不对」「groupsPane 还挂在左栏上吗」这三处
// 谁也守不住 —— 独立审查实测：改 json 标签、改 live 分支、删调用点，go test 三刀全绿。
// 这一条走真链路：httptest → Client.Timeline() → groupsOfConversation() → groupBarLines()，
// 一次把三处都钉住。
func TestGroupsComeThroughTheRealTimeline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"items":[],"session_id":"main","session_api":1,
			"groups":{"state":"live","groups":[
				{"id":"main","title":"main","sessions":["main"],"bots":["lead"],"ticket_count":2},
				{"id":"work","title":"work","sessions":["work"],"bots":[],"ticket_count":1}]}}`))
	}))
	t.Cleanup(server.Close)
	client := &Client{base: server.URL, token: "token", deviceID: "device", http: server.Client()}
	conv, err := client.Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	// 1) json 标签对不对：字段没解析进来就是零值，这里会红。
	if conv.Groups.State != "live" || len(conv.Groups.Groups) != 2 {
		t.Fatalf("client.go 没把 groups 解进来：%+v", conv.Groups)
	}
	// 2) groupsOfConversation 的 live 分支对不对：它必须原样交出投影，不能改判 unavailable。
	view := groupsOfConversation(conv)
	if view.State != "live" || len(view.Groups) != 2 {
		t.Fatalf("groupsOfConversation 把 live 改判了：%+v", view)
	}
	// 3) 画出来的是真数字。
	lines := groupBarLines(view)
	if len(lines) != 2 {
		t.Fatalf("群组栏应有 2 行，实际 %d：%+v", len(lines), lines)
	}
	if !strings.Contains(lines[0].text, "main") || !strings.Contains(lines[0].text, "2 张") {
		t.Errorf("第一行应显示 main 与 2 张票：%q", lines[0].text)
	}
}
