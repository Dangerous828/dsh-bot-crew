package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 代码块是「改了什么」的证据。解析错了不会报错，只会画出一张空卡 ——
// 所以这里钉住字段名与三种行类型。
func TestMessageCarriesItsCodeBlock(t *testing.T) {
	raw := `{
		"id": "m1", "role": "agent", "text": "改好了",
		"code": {
			"path": "login.tsx", "added": 2, "removed": 1,
			"lines": [
				{"text": "gap: 12px;", "kind": "context"},
				{"text": "gap: 16px;", "kind": "added"},
				{"text": "padding-bottom: 0;", "kind": "removed"}
			]
		}
	}`
	var message Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	block := message.Code()
	if block == nil {
		t.Fatal("消息里带了 code，但没取出来")
	}
	if block.Path != "login.tsx" || block.Added != 2 || block.Removed != 1 {
		t.Errorf("表头解析错: %+v", block)
	}
	if len(block.Lines) != 3 {
		t.Fatalf("应有 3 行，实际 %d", len(block.Lines))
	}
	if block.Lines[1].Kind != "added" || block.Lines[2].Kind != "removed" {
		t.Errorf("行类型解析错: %+v", block.Lines)
	}
}

// 没有代码块的消息要返回 nil，不能返回一张空卡。
func TestMessageWithoutCodeHasNoBlock(t *testing.T) {
	var message Message
	if err := json.Unmarshal([]byte(`{"id":"m2","role":"user","text":"你好"}`), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if message.Code() != nil {
		t.Error("没带代码却拿到了代码块")
	}
}

// 后端若把字段叫 diff，也要认。
func TestCodeAcceptsDiffNaming(t *testing.T) {
	raw := `{"id":"m3","role":"agent","text":"x","diff":{"path":"a.ts","added":1,"removed":0,"lines":[{"text":"x","kind":"added"}]}}`
	var message Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	block := message.Code()
	if block == nil || block.Path != "a.ts" {
		t.Fatalf("diff 这种命名没认出来: %+v", block)
	}
}

// 代码卡下面两个按钮要知道「对谁做」：采用要点名写这段的 Bot，看效果要知道是哪张票。
// 票号优先取代码块自己的，其次才取消息上那个只读的 ticket_ref。
func TestCodeCarriesTheTicketItBelongsTo(t *testing.T) {
	raw := `{"id":"m4","role":"agent","bot_id":"coder","text":"x","ticket_ref":"tk-9",
		"code":{"path":"a.ts","added":2,"removed":0,"lines":[{"text":"x","kind":"added"}]}}`
	var message Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	block := message.Code()
	if block == nil || block.TicketRef != "tk-9" {
		t.Fatalf("消息上的 ticket_ref 没落到代码块里: %+v", block)
	}
	if block.ID == "" {
		t.Error("代码块没有稳定标识：两张卡的回执会串台")
	}

	// 代码块自己带了票号时以它为准：同一段对话里可以挂着不同工单的改动。
	own := `{"id":"m5","role":"agent","text":"x","ticket_ref":"tk-outer",
		"code":{"path":"b.ts","ticket_ref":"tk-inner","lines":[{"text":"y","kind":""}]}}`
	var second Message
	if err := json.Unmarshal([]byte(own), &second); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got := second.Code(); got == nil || got.TicketRef != "tk-inner" {
		t.Fatalf("代码块自己的票号被消息上的盖掉了: %+v", got)
	}
}

// 「采用」发出去的那句话：点名写这段的 Bot，带上文件名与增删统计。
// 没有名字就只点名 id —— 不硬加一个「@队伍」。
func TestAdoptTextNamesTheBotThatWroteIt(t *testing.T) {
	block := CodeBlock{Path: "login.tsx", Added: 8, Removed: 4}
	if got, want := adoptText(block, "coder", "码农"), "@coder（码农） 采用 login.tsx 这段改动，加 8 行、删 4 行，按这个改。"; got != want {
		t.Errorf("采用这句话不对:\n got %q\nwant %q", got, want)
	}
	// 名字和 id 一样时只说一遍：@coder（coder）读起来像写错了。
	if got, want := adoptText(block, "coder", "coder"), "@coder 采用 login.tsx 这段改动，加 8 行、删 4 行，按这个改。"; got != want {
		t.Errorf("名字与 id 相同时不该重复:\n got %q\nwant %q", got, want)
	}
	// 没有统计就只说采用了哪段，不编一个「加 0 行」。
	if got := adoptText(CodeBlock{Path: "a.ts"}, "", ""); got != "采用 a.ts 这段改动，按这个改。" {
		t.Errorf("没有增删统计时说得不对: %q", got)
	}
}

// 采用一次就够：正在发、已经采用过的卡都不再接第二下，
// 回执也只写在它自己那张卡下面 —— 并发下最容易串台的就是这两处。
//
// 这里不给 client：adopt 在真正发请求前就返回了，正好只用来看状态判断。
func TestAdoptingIsOncePerCard(t *testing.T) {
	s := newApp(nil)
	block := CodeBlock{ID: "tk-1|login.tsx", Path: "login.tsx", Added: 1}
	s.conversation = &Conversation{}

	// 还没采用过：这张卡算「正在采用」，按钮据此转圈、不再接第二下。
	s.adopting[block.ID] = true
	s.adopt(block, "coder")
	if !s.adopting[block.ID] {
		t.Error("「采用中」不该被自己清掉：按钮会提前变回「采用」，能连点")
	}

	// 结果回来之后：记下已采用，回执只挂在自己这张卡上。
	delete(s.adopting, block.ID)
	s.adoptedOK[block.ID] = true
	s.noteAdopt(block.ID, "已请它采用这段改动，下一步会按这个改")

	s.adopt(block, "coder")
	if s.adopting[block.ID] {
		t.Error("已采用的卡又被接了一下：不该再发第二遍")
	}
	if _, ok := s.adoptNotes["tk-2|a.ts"]; ok {
		t.Error("回执串到别的卡上了")
	}
	if s.adoptNotes[block.ID] == "" {
		t.Error("回执没留在它自己那张卡上")
	}
}

// 代码卡下面那两个按钮真的画出来了，而且真的打到已有的通道上：
// 「采用」发一条普通消息（/api/mobile/send），「看看改完的样子」读那张票的屏幕（/api/mobile/screen）。
// 这一条把「点得动」钉住：只画不接的按钮，就是用户在画板上说的「点什么都没反应」。
func TestCodeCardButtonsReachTheExistingChannels(t *testing.T) {
	// 这条带代码的回复在时间线里会原样再来一次（采用之后要重读时间线），
	// 所以它同时是初始对话和服务器返回的那一份。
	const reply = `{"id":"r7","role":"agent","bot_id":"coder","at":"2026-11-11T10:00:00Z","text":"改好了",` +
		`"code":{"path":"login.tsx","added":8,"removed":4,"ticket_ref":"tk-1",` +
		`"lines":[{"text":"gap: 16px;","kind":"added"}]}}`

	sent := make(chan string, 1)
	screens := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/send":
			var body struct {
				Text string `json:"text"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			sent <- body.Text
			_, _ = w.Write([]byte(`{"ok":true,"id":"x","request_id":"r"}`))
		case "/api/mobile/screen":
			screens <- r.URL.Query().Get("ticket")
			_, _ = w.Write([]byte(`{"state":"unavailable","reason":"这张工单还没有可读的执行记录"}`))
		case "/api/mobile/timeline":
			_, _ = w.Write([]byte(`{"items":[` + reply + `],"tasks":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	var message Message
	if err := json.Unmarshal([]byte(reply), &message); err != nil {
		t.Fatalf("测试用的回复解不开：%v", err)
	}
	s := newApp(New(server.URL, "secret", ""))
	s.conversation = &Conversation{
		Bots:     []BotCard{{ID: "coder", Name: "码农"}},
		Messages: []Message{message},
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	for _, label := range []string{"采用", "看看改完的样子"} {
		if !tt.HasText(label) {
			t.Fatalf("代码卡下面没有「%s」；画的是 %v", label, tt.Texts())
		}
	}

	rect, ok := tt.Find("采用")
	if !ok {
		t.Fatalf("找不到「采用」")
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	select {
	case text := <-sent:
		if !strings.Contains(text, "login.tsx") || !strings.Contains(text, "@coder") {
			t.Errorf("采用发出去的这句话没说清是对哪一段、对谁：%q", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("点了「采用」，请求没有打到 /api/mobile/send")
	}
	waitFor(t, tt, "采用的结果回到界面", func() bool { return !s.adopting["tk-1|login.tsx"] })
	if s.problem != "" {
		t.Errorf("采用成功却写进了全局 problem：%q", s.problem)
	}
	if !tt.HasText("✓ 已采用") {
		t.Errorf("采用之后按钮没变成「✓ 已采用」；画的是 %v", tt.Texts())
	}

	rect, ok = tt.Find("看看改完的样子")
	if !ok {
		t.Fatalf("找不到「看看改完的样子」")
	}
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	select {
	case ticket := <-screens:
		if ticket != "tk-1" {
			t.Errorf("看的是 %q 的屏幕，应该是这段改动所属的 tk-1", ticket)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("点了「看看改完的样子」，请求没有打到 /api/mobile/screen")
	}
	waitFor(t, tt, "看不了时给出实话", func() bool { return s.previewNote != "" })
	if s.problem != "" {
		t.Errorf("看不了写进了全局 problem（那是断连横幅的位置）：%q", s.problem)
	}
}
