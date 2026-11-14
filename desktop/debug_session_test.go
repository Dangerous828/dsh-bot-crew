package main

// debug_session_test.go —— 桌面调试口的会话动作与记忆动作（issue #18 第 2、3 项）。
//
// 为什么要有这一组：真 GUI 验收不许抢焦点、不许发桌面输入事件，而界面上的
// 「点左栏那一段会话」「点编辑、点保存」在自动化眼里都是像素。调试口原来只有
// 31 条动作、零条 session.*，所以「切会话」只能人手点 —— issue 明说这条路
// 没法自动化。这里补上 session.list / session.set / session.reload，并让记忆编辑
// 也有可寻址入口（memory.edit / memory.save / memory.dump），
// 语义与手机端 app/.../CrewDebug.kt 同名动作一致。
//
// 三条约束在这里被钉住：
//  1. 动作调的是界面按一下会调的同一个方法（switchSession / editMemory / saveMemory），
//     调试口不另造第二套行为；
//  2. 能力位没到 live 时 session.set 一律拒绝，不绕过先验造出界面做不到的状态；
//  3. 切会话之后发出去的那一句真的落到切过去的那段会话（真 HTTP 假后端记账）。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// debugFixture 把「真 HTTP 假队伍 + 真窗口画法 + 调试动作表」接在一起。
// 返回的 tester 每 Frame 一次就会跑一遍 drain，后台结果才能落进状态。
func debugFixture(t *testing.T) (*guiBackend, *sessionLog, *app, *DebugBus, *ui.Tester) {
	t.Helper()
	backend, log, s := guiFixture(t)
	bus := newDebugBus(s)
	tt := sessionGUI(s)
	return backend, log, s, bus, tt
}

// invokeRaw 调一条动作并把它当成「外部自动化看到的那一份」——即 socket 上那份 JSON 形状。
func invokeRaw(t *testing.T, bus *DebugBus, action string, args map[string]any) (any, error) {
	t.Helper()
	raw := map[string]json.RawMessage{}
	for key, value := range args {
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal %s: %v", key, err)
		}
		raw[key] = payload
	}
	return bus.invoke(action, raw)
}

// session.list 报的是「这一刻能不能切、现在在哪一段、名单是什么」，
// 与手机端同名动作同一套字段（capability / switchable / current / default / note / sessions）。
func TestDebugBusSessionListMirrorsPhoneShape(t *testing.T) {
	_, _, s, bus, tt := debugFixture(t)
	s.refresh()
	waitFor(t, tt, "能力位先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })

	out, err := invokeRaw(t, bus, "session.list", nil)
	if err != nil {
		t.Fatalf("session.list: %v", err)
	}
	view, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("session.list 应回一个对象，实际 %T", out)
	}
	if view["capability"] != "live" || view["switchable"] != true {
		t.Errorf("能力位应是 live/可切，实际 %v/%v", view["capability"], view["switchable"])
	}
	if view["current"] != "main" || view["default"] != "main" {
		t.Errorf("当前/缺省会话不对：%v/%v", view["current"], view["default"])
	}
	rows, _ := view["sessions"].([]map[string]any)
	if len(rows) != 2 || rows[0]["id"] != "main" || rows[1]["id"] != "work" {
		t.Fatalf("名单不对：%v", view["sessions"])
	}
	if rows[0]["current"] != true || rows[1]["current"] != false {
		t.Errorf("current 标错：%v", rows)
	}
}

// session.set 切过去之后，后续请求真的带 ?session_id=work，且发出去的那一句落到 work。
// 这条就是 issue #18 第 2 项要的「真 GUI 切会话」，只是入口从像素换成了按名字调。
func TestDebugBusSessionSetSwitchesAndSendLandsInThatSession(t *testing.T) {
	backend, log, s, bus, tt := debugFixture(t)
	s.refresh()
	waitFor(t, tt, "先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })
	waitFor(t, tt, "main 的时间线落地", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "main"
	})

	out, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "work"})
	if err != nil {
		t.Fatalf("session.set work: %v", err)
	}
	if got, _ := out.(map[string]any)["session"].(string); got != "work" {
		t.Fatalf("session.set 回了 %q，应为 work", got)
	}
	if s.currentSession != "work" || s.client.ActiveSession() != "work" {
		t.Fatalf("切了但状态没跟上：app=%q client=%q", s.currentSession, s.client.ActiveSession())
	}
	waitFor(t, tt, "切过去后读到 work 的时间线", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "work"
	})
	if got := callsMatching(log, "/api/mobile/timeline?session_id=work"); len(got) == 0 {
		t.Fatalf("切到 work 之后没发带 session_id 的时间线：%v", log.all())
	}

	// 发一句：走界面同一个 send()，落到 work。
	log.reset()
	if _, err := invokeRaw(t, bus, "send", map[string]any{"text": "真 GUI 经调试口切过去之后发的一句"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, tt, "这一句真的发出去了", func() bool {
		return len(callsMatching(log, "/api/mobile/send")) > 0
	})
	sent := callsMatching(log, "/api/mobile/send")
	last := sent[len(sent)-1]
	if last.url != "/api/mobile/send?session_id=work" {
		t.Errorf("发送打到了 %q，应为 ?session_id=work", last.url)
	}
	if got := last.headers.Get(sessionHeader); got != "work" {
		t.Errorf("x-crew-session = %q，应为 work", got)
	}
	if !strings.Contains(last.body, "真 GUI 经调试口切过去之后发的一句") {
		t.Errorf("正文没带上那句话：%q", last.body)
	}
	if got := len(backend.timeline("work")); got != 2 {
		t.Errorf("work 的时间线应多出这一句（2 条），实际 %d 条", got)
	}
	if got := len(backend.timeline("main")); got != 2 {
		t.Errorf("main 被串进来一条：现在 %d 条", got)
	}

	// 切回 main：两段缓存各归各的，不互相顶掉。
	waitFor(t, tt, "发送后重读回 work", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "work" && len(s.conversation.Messages) == 2
	})
	workConv := s.conversation
	if _, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "main"}); err != nil {
		t.Fatalf("session.set main: %v", err)
	}
	waitFor(t, tt, "切回 main 读到 main 的时间线", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "main"
	})
	if len(s.conversation.Messages) != 2 || s.conversation.Messages[0].Text != "主线第一句" {
		t.Errorf("main 的缓存不对：%+v", s.conversation.Messages)
	}
	if s.conversations["work"] != workConv {
		t.Error("切回 main 之后 work 的缓存被换掉了")
	}
	if len(workConv.Messages) != 2 || workConv.Messages[0].Text != "工作线第一句" {
		t.Errorf("work 的缓存被 main 顶掉了：%+v", workConv.Messages)
	}
}

// 能力位没到 live 时 session.set 必须拒绝：调试口不绕过先验，
// 否则「调试一下」就能造出界面做不到的状态（与手机端 CrewDebug 同一条规矩）。
func TestDebugBusSessionSetRefusesWhenCapabilityLocked(t *testing.T) {
	_, _, s, bus, _ := debugFixture(t)
	s.lockToMain(legacySessionNote)
	s.sessionsChecked = true
	s.sessions = []string{"main", "work"} // 名单里有也不许切：能力位才是门禁
	if _, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "work"}); err == nil {
		t.Fatal("能力位没到 live 却切成功了")
	} else if !strings.Contains(err.Error(), "locked") || !strings.Contains(err.Error(), "unsupported") {
		t.Errorf("拒绝理由要带上能力位，实际 %v", err)
	}
	if s.currentSession != "main" || s.client.ActiveSession() != "main" {
		t.Fatalf("被拒之后会话被改动了：app=%q client=%q", s.currentSession, s.client.ActiveSession())
	}
}

// 名单里没有的会话名一律拒绝，且不换客户端（形状不对的在传输层也会被挡）。
func TestDebugBusSessionSetRejectsUnknownAndMalformed(t *testing.T) {
	_, _, s, bus, tt := debugFixture(t)
	s.refresh()
	waitFor(t, tt, "先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })

	if _, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "beta"}); err == nil {
		t.Fatal("名单里没有 beta 却切成功了")
	}
	if s.currentSession != "main" {
		t.Fatalf("被拒之后当前会话变成 %q", s.currentSession)
	}
	// 缺参数明确报错，不把空串当默认值悄悄吞掉。
	if _, err := invokeRaw(t, bus, "session.set", nil); err == nil {
		t.Fatal("缺 session 参数却成功了")
	}
	// 形状非法：大写成份不是合法会话名（与手机端、后端同一套 SESSION_NAME）。
	if _, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "Work!"}); err == nil {
		t.Fatal("非法会话名却成功了")
	}
}

// session.reload 等价于点界面那次重试：重新先验，名单从后端重拉。
// 真机验收里在别的门新建了会话，桌面不重拉名单就永远只看到旧的。
func TestDebugBusSessionReloadReprobesTheList(t *testing.T) {
	backend, log, s, bus, tt := debugFixture(t)
	s.refresh()
	waitFor(t, tt, "先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })

	// 后端那边多了一段会话；本地名单还是旧的。
	backend.add("gamma")
	s.sessions = []string{"main", "work"}
	before := len(callsMatching(log, "/api/mobile/sessions"))

	if _, err := invokeRaw(t, bus, "session.reload", nil); err != nil {
		t.Fatalf("session.reload: %v", err)
	}
	waitFor(t, tt, "重拉之后名单里有 gamma", func() bool {
		return len(s.sessions) == 3 && s.sessions[2] == "gamma"
	})
	if got := len(callsMatching(log, "/api/mobile/sessions")) - before; got != 1 {
		t.Errorf("session.reload 应恰好再发一次 GET /sessions，实际 %d 次", got)
	}
}

// 记忆：memory.dump 读得到账本，memory.edit 打开的是界面那一层、memory.save 走
// 界面同一个收口（Client.EditMemory → applyAction）。改的那条真的进了请求体。
func TestDebugBusMemoryEditAndSave(t *testing.T) {
	var posts []string
	items := []map[string]any{
		{"name": "bot-lead-a", "bot_id": "lead", "description": "旧标题", "body": "旧正文",
			"state": "active", "type": "fact", "updated": 1794000000},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"state": "live", "items": items, "counts": map[string]int{"active": 1},
			})
		case http.MethodPost:
			raw, _ := io.ReadAll(r.Body)
			posts = append(posts, string(raw))
			_, _ = w.Write([]byte(`{"ok":true,"name":"bot-lead-a"}`))
		}
	}))
	defer server.Close()

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	bus := newDebugBus(s)
	tt := sessionGUI(s)

	if _, err := invokeRaw(t, bus, "memory.reload", nil); err != nil {
		t.Fatalf("memory.reload: %v", err)
	}
	waitFor(t, tt, "记忆读回来", func() bool { return s.memory != nil && len(s.memory.Items) == 1 })

	dump, err := invokeRaw(t, bus, "memory.dump", nil)
	if err != nil {
		t.Fatalf("memory.dump: %v", err)
	}
	view, _ := dump.(map[string]any)
	if view["state"] != "live" {
		t.Fatalf("memory.dump 的 state 不对：%v", view)
	}
	if rows, _ := view["items"].([]map[string]any); len(rows) != 1 || rows[0]["name"] != "bot-lead-a" {
		t.Fatalf("memory.dump 的条目不对：%v", view["items"])
	}

	// 打开编辑层：填的是这条现在的值，与界面点「编辑」同一个入口。
	if _, err := invokeRaw(t, bus, "memory.edit", map[string]any{
		"name": "bot-lead-a", "description": "新标题", "body": "新正文",
	}); err != nil {
		t.Fatalf("memory.edit: %v", err)
	}
	if s.actions.editingMemory != "bot-lead-a" || s.actions.memoryDescription != "新标题" || s.actions.memoryBody != "新正文" {
		t.Fatalf("编辑层没打开或草稿不对：%+v", s.actions)
	}

	if _, err := invokeRaw(t, bus, "memory.save", nil); err != nil {
		t.Fatalf("memory.save: %v", err)
	}
	if len(posts) != 1 {
		t.Fatalf("应恰好发一次 POST /memory，实际 %d 次：%v", len(posts), posts)
	}
	for _, want := range []string{`"action":"edit"`, `"name":"bot-lead-a"`, `"description":"新标题"`, `"body":"新正文"`} {
		if !strings.Contains(posts[0], want) {
			t.Errorf("请求体缺 %s：%s", want, posts[0])
		}
	}
	// 成功后与界面一样关层；失败才留层。这里等 drain 把重读收掉。
	if s.actions.editingMemory != "" {
		t.Errorf("保存成功后编辑层没关：%q", s.actions.editingMemory)
	}
}

// 后端拒绝时（HTTP 200 + ok:false）memory.save 要如实报错，编辑层留着，不假装改完。
func TestDebugBusMemorySaveReportsRefusalAndKeepsEditor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"state": "live", "items": []map[string]any{{"name": "bot-lead-a", "body": "旧"}}, "counts": map[string]int{"active": 1},
			})
			return
		}
		_, _ = w.Write([]byte(`{"ok":false,"reason":"后端还没有接入记忆"}`))
	}))
	defer server.Close()

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	bus := newDebugBus(s)
	tt := sessionGUI(s)
	if _, err := invokeRaw(t, bus, "memory.reload", nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, tt, "记忆读回来", func() bool { return s.memory != nil })

	if _, err := invokeRaw(t, bus, "memory.edit", map[string]any{"name": "bot-lead-a", "body": "新"}); err != nil {
		t.Fatal(err)
	}
	if _, err := invokeRaw(t, bus, "memory.save", nil); err == nil {
		t.Fatal("后端拒绝却报成功了")
	} else if !strings.Contains(err.Error(), "后端还没有接入记忆") {
		t.Errorf("没把后端 reason 带回来：%v", err)
	}
	if s.actions.editingMemory != "bot-lead-a" {
		t.Errorf("失败后编辑层被关掉了：%q", s.actions.editingMemory)
	}
	if !strings.Contains(s.actions.memoryEditError, "后端还没有接入记忆") {
		t.Errorf("失败原因没留在层里：%q", s.actions.memoryEditError)
	}
}

// memory.edit 只认账本里真有的那一条：不拿名字凭空造编辑层（后端也只认 bot- 前缀）。
func TestDebugBusMemoryEditRejectsUnknownName(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)
	s.memory = &MemoryView{State: "live", Items: []MemoryItem{{Name: "bot-lead-a"}}}
	if _, err := invokeRaw(t, bus, "memory.edit", map[string]any{"name": "bot-other"}); err == nil {
		t.Fatal("账本里没有的名字却打开了编辑层")
	}
	if s.actions.editingMemory != "" {
		t.Errorf("被拒之后编辑层开着：%q", s.actions.editingMemory)
	}
}

// state.dump 要能一眼看出「现在在哪一段会话、能不能切、记忆记得几条」——
// 真 GUI 验收全靠这份快照断言，不用去看像素。
func TestDebugStateDumpCarriesSessionAndMemory(t *testing.T) {
	_, _, s, bus, tt := debugFixture(t)
	s.refresh()
	waitFor(t, tt, "先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })
	waitFor(t, tt, "时间线落地", func() bool { return s.conversation != nil })

	out, err := invokeRaw(t, bus, "state.dump", nil)
	if err != nil {
		t.Fatalf("state.dump: %v", err)
	}
	snap, _ := out.(map[string]any)
	if snap["session"] != "main" || snap["sessionCapability"] != "live" || snap["sessionSwitchable"] != true {
		t.Errorf("会话字段不对：%v / %v / %v", snap["session"], snap["sessionCapability"], snap["sessionSwitchable"])
	}
	if listed, _ := snap["sessions"].([]string); len(listed) != 2 || listed[1] != "work" {
		t.Errorf("sessions 字段不对：%v", snap["sessions"])
	}
	if _, ok := snap["memoryCount"]; !ok {
		t.Error("state.dump 没带记忆条数")
	}
}
