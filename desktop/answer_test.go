package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 「等你决定」卡上的 A/B 点一下就直接答：不经过输入框，也不多一步「再按发送」。
// 这一组盯四件事：选项画成能点的按钮、点一下只发一遍、回执只落在它自己那张卡上，
// 以及没问题时退回 needs_person 那句人话。
// 最后一条钉住答完就换代的那处尾巴：同一张票换了新问题，旧回执不该挂到新问题下面。

// askedTicket 是时间线里那张待决的票：有具体问题，也有两个选项。
const askedTicket = `{"id":"tk-1","title":"改首页","state":"waiting","open":true,"bot_id":"lin",` +
	`"needs_person":"answer","question":"首页先改哪一块？",` +
	`"options":[{"id":"opt-a","label":"去改首页"},{"id":"opt-b","label":"先放着"}]}`

// newTicket 是同一张票换了问题之后的样子：票号没变，问的和选项都变了。
const newTicket = `{"id":"tk-1","title":"改首页","state":"waiting","open":true,"bot_id":"lin",` +
	`"needs_person":"answer","question":"首页改完了，下一步做哪块？",` +
	`"options":[{"id":"opt-c","label":"做登录"}]}`

// taskFromJSON 把一条票按时间线里的写法解出来：测试用的票就走真实那条解析路。
func taskFromJSON(t *testing.T, raw string) Task {
	t.Helper()
	var task Task
	if err := json.Unmarshal([]byte(raw), &task); err != nil {
		t.Fatalf("测试用的票解不开：%v", err)
	}
	return task
}

// askedConversation 是同一张票的本地那一份。
func askedConversation(t *testing.T) *Conversation {
	return &Conversation{
		Bots:     []BotCard{{ID: "lin", Name: "林", Persona: "前端，先看现有约定。"}},
		Messages: []Message{{ID: "m1", Role: "agent", BotID: "lin", At: "2026-11-11T10:00:00Z", Text: "首页我看了"}},
		Tasks:    []Task{taskFromJSON(t, askedTicket)},
	}
}

// timelineWith 是重读时间线时给回去的那一份。消息写死一条：没有消息时中间栏是空态，
// 待决的卡根本不画 —— 那样测的就不是卡了。
func timelineWith(ticket string) string {
	return `{"items":[{"id":"m1","role":"agent","bot_id":"lin","at":"2026-11-11T10:00:00Z","text":"首页我看了"}],` +
		`"bots":[{"id":"lin","name":"林"}],"tasks":[` + ticket + `]}`
}

// newConversation 是换了问题之后的那一份本地状态。
func newConversation(t *testing.T) *Conversation {
	return &Conversation{
		Bots:     []BotCard{{ID: "lin", Name: "林", Persona: "前端，先看现有约定。"}},
		Messages: []Message{{ID: "m1", Role: "agent", BotID: "lin", At: "2026-11-11T10:00:00Z", Text: "首页我看了"}},
		Tasks:    []Task{taskFromJSON(t, newTicket)},
	}
}

// TestThePendingCardAnswersFromItsOwnButtons 钉住「点得动」与「只发一遍」：
// 选项是带手型指针的按钮，点一下打到已有的 /api/mobile/send；发着的那一下不再接第二下。
func TestThePendingCardAnswersFromItsOwnButtons(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	sent := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/send":
			var body struct {
				Text string `json:"text"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			sent <- body.Text
			// 卡住不回，让「正在发」的那一帧真的存在：连点就发生在这一刻。
			<-release
			_, _ = w.Write([]byte(`{"ok":true,"id":"x","request_id":"r"}`))
		case "/api/mobile/timeline":
			// 答完之后那次重读，回来的已经是下一道题：正是这条尾巴的现场。
			_, _ = w.Write([]byte(timelineWith(newTicket)))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	// 晚于 Close 注册 = 早于它执行：请求还卡着时先把门打开，否则关服务器会一直等。
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = askedConversation(t)
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	if !tt.HasText("首页先改哪一块？") {
		t.Fatalf("问题没画出来；画的是 %v", tt.Texts())
	}
	for _, label := range []string{"去改首页", "先放着"} {
		if !tt.HasText(label) {
			t.Fatalf("选项「%s」没有画成按钮；画的是 %v", label, tt.Texts())
		}
	}

	rect, ok := tt.Find("去改首页")
	if !ok {
		t.Fatalf("找不到选项「去改首页」")
	}
	tt.Move(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()
	if got := tt.Cursor(); got != ui.CursorPointer {
		t.Errorf("指针停在选项上是 %v，应该是手型：这一格点得动", got)
	}

	// 点下去的同时请求卡在服务器那头：刷一次帧，让「正在发」的 ✓ 落进画里。
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()
	if !tt.HasText("✓") {
		t.Errorf("发着的时候选项没有换成 ✓；画的是 %v", tt.Texts())
	}

	// 连点第二下：正在发的那一格里已经有答案了，不该再发一遍。
	// 按那一行原来的位置再点一次：换成的 ✓ 还在同一格。
	tt.ClickAt(rect.X+rect.W/2, rect.Y+rect.H/2)
	tt.Frame()
	select {
	case text := <-sent:
		if text != "@林 去改首页" {
			t.Errorf("点选项发出去的是 %q，应该是点名在等的那位、带上这句话", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("点选项没有打到 /api/mobile/send")
	}
	time.Sleep(50 * time.Millisecond)
	select {
	case text := <-sent:
		t.Fatalf("连点了两下，发出去两句：%q", text)
	default:
	}

	once.Do(func() { close(release) })
	// 重读回来的已经是下一道题：上一道题的回执既不留在状态里，也不画在新问题下面。
	waitFor(t, tt, "重读回来的是下一道题", func() bool { return tt.HasText("首页改完了，下一步做哪块？") })
	if s.problem != "" {
		t.Errorf("答了一句却写进了全局 problem（那是断连横幅）：%q", s.problem)
	}
	if s.answerNote != "" {
		t.Errorf("答完重读成了新问题，却留下了上一道题的回执：%q", s.answerNote)
	}
	if tt.HasText("已按这个答了，队伍下一步会接上") {
		t.Error("新问题卡下面出现了旧回执：那句「已按这个答了」说的不是这道题")
	}

	// 回执只写在自己那张卡上：换成别的票，这句话也不该再画出来。
	s.answerTicket, s.answerAsked = "tk-2", answerSignature(s.conversation.Tasks[0])
	s.answerNote = "已按这个答了，队伍下一步会接上"
	tt.Frame()
	if tt.HasText("已按这个答了，队伍下一步会接上") {
		t.Error("回执串到别的票上了：A 答完，B 的卡上也说了一句")
	}
}

// TestTheAnswerNoteDoesNotFollowANewQuestion 是那处尾巴：答完重读回来，
// 同一张票已经换了一组新问题，旧回执不能短暂地挂在新问题下面。
//
// 三条都钉：问题没变时回执照旧要说（别把正常情况一起收没了）；结果回到界面时
// 票上已经是新问题（成功也不留那句话）；回执先写进状态、新问题后到（刷新把它清掉）。
// 中间那一帧就是人看到的闪一下。
//
// 这里不给 client：结果与刷新都直接放进通道，正好只看状态与画出来的那一帧。
func TestTheAnswerNoteDoesNotFollowANewQuestion(t *testing.T) {
	askedTask := taskFromJSON(t, askedTicket)
	newTask := taskFromJSON(t, newTicket)
	if askedTask.ID != newTask.ID {
		t.Fatalf("测试本身有问题：两道题不是同一张票（%q / %q）", askedTask.ID, newTask.ID)
	}
	if answerSignature(askedTask) == answerSignature(newTask) {
		t.Fatalf("测试本身有问题：两道题算出来的签名一样（%q），换代的判断就无从谈起", answerSignature(askedTask))
	}
	asked := answerSignature(askedTask)
	note := "已按这个答了，队伍下一步会接上"

	// 零、卡上还是同一道题：这句回执照旧要说。
	same := newApp(nil)
	same.conversation = askedConversation(t)
	same.answerTicket, same.answerAsked = "tk-1", asked
	same.answered <- answerResult{key: "tk-1|opt-a", ticket: "tk-1", asked: asked}
	sameTester := ui.NewTester(func(c *ui.Context) { same.view(c) }, 1200, 700)
	sameTester.Frame()
	if same.answerNote != note {
		t.Errorf("问题没变，成功之后的回执是 %q，应该照说", same.answerNote)
	}
	if !sameTester.HasText(note) {
		t.Errorf("问题没变，回执没画在它自己那张卡下；画的是 %v", sameTester.Texts())
	}

	// 一、结果回来时，卡上问的已经是下一件事。
	s := newApp(nil)
	s.conversation = newConversation(t)
	s.answerTicket, s.answerAsked = "tk-1", asked
	s.answered <- answerResult{key: "tk-1|opt-a", ticket: "tk-1", asked: asked}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	if !tt.HasText("首页改完了，下一步做哪块？") {
		t.Fatalf("新问题没画出来；画的是 %v", tt.Texts())
	}
	if s.answerNote != "" {
		t.Errorf("成功答的是上一道题，却留下了回执：%q", s.answerNote)
	}
	if tt.HasText(note) {
		t.Error("新问题卡下面出现了旧回执：那句话说的不是这道题")
	}

	// 二、回执先写了、新问题后到：刷新回来时把它清掉，而不是一直挂着。
	s.answerTicket, s.answerAsked = "tk-1", asked
	s.answerNote = note
	tt.Frame()
	if tt.HasText(note) {
		t.Error("签名对不上时卡片还画了旧回执")
	}

	s.arrived <- newConversation(t)
	tt.Frame()
	if s.answerNote != "" {
		t.Errorf("换了新问题，旧回执照旧留在状态里：%q", s.answerNote)
	}
	if tt.HasText(note) {
		t.Error("旧回执出现在新问题卡下面")
	}
}

// TestAPendingCardWithoutAQuestionNamesWhatItWaitsFor：后端没给问题就不编选项，
// 只退回 needs_person 那句人话，并留着「自己写一句」。
func TestAPendingCardWithoutAQuestionNamesWhatItWaitsFor(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{
		Bots:     []BotCard{{ID: "lin", Name: "林", Persona: "前端，先看现有约定。"}},
		Messages: []Message{{ID: "m1", Role: "agent", BotID: "lin", At: "2026-11-11T10:00:00Z", Text: "改完了"}},
		Tasks: []Task{{
			ID: "tk-2", Title: "发布", State: "waiting", Open: true, BotID: "lin", NeedsPerson: "review",
		}},
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1200, 700)
	tt.Frame()

	if !tt.HasText("这张票卡在等你，原因：活干完了，等你过目") {
		t.Errorf("没问题时没有退回 needs_person 的说法；画的是 %v", tt.Texts())
	}
	// 没有选项就一个 A/B 都不该有：前端不替后端编答案。
	// 按整条字比，不用包含判断 —— 别的文案里出现一个 A 不该算成选项。
	for _, text := range tt.Texts() {
		if text == "A" || text == "B" {
			t.Errorf("没问题却画出了选项序号 %q：选项只能来自后端", text)
		}
	}
	if !tt.HasText("自己写一句…") {
		t.Errorf("没有选项时也该留着「自己写一句…」；画的是 %v", tt.Texts())
	}
}
