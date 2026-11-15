package main

// state_pump_test.go —— 状态推进不挂在绘制上（issue #27）。
//
// 这一组钉住「后台结果到达即落状态」这件事本身，与画帧无关：
// 窗口被遮挡 / 锁屏 / App Nap 时一帧都不会来，但通道里的结果必须照样进状态，
// 否则 state.dump 恒为 messages:-1（真机症状见 docs/PHASE_ISSUE18_RELAY_AND_GUI.md §3.5）。
//
// 判据的写法：**不建 Tester、不调 view()**，只跑主线程队列（生产里就是
// mygo.Window.Update 收的那些任务）。这里绿了，说明推进真的只依赖数据到达。

import (
	"net/http"
	"testing"
	"time"
)

// waitForNoFrame 反复把 s 的主线程队列跑完，直到 ok() 成立。它**不画任何一帧**：
// 这是与 waitFor 的唯一区别，也是这一组用例的全部意义。
func waitForNoFrame(t *testing.T, s *app, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.runPending()
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("不画帧就等不到：%s", what)
}

// 一帧都不画：先验 → 时间线 → 消息条数，全部自己跟上。
func TestStateAdvancesWithoutAFrame(t *testing.T) {
	backend, _, s := guiFixture(t)

	// 起窗口那次刷新（等价于 main.go 里 WhenReady 之后那一句）。
	s.refresh()

	waitForNoFrame(t, s, "能力位先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })
	waitForNoFrame(t, s, "main 的时间线落地", func() bool {
		return s.conversation != nil && s.conversation.SessionID == "main" && len(s.conversation.Messages) > 0
	})

	// 条数与后端逐字一致 —— 不是「-1」，也不是 0。
	if want, got := len(backend.timeline("main")), s.currentMessageCount(); got != want {
		t.Fatalf("不画帧时 messages = %d，应为 %d", got, want)
	}
}

// 记忆那一栏同理：没人画帧，memoryCount 也得跟上。
func TestMemoryCountAdvancesWithoutAFrame(t *testing.T) {
	server, _ := sessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mobile/memory" {
			_, _ = w.Write([]byte(`{"state":"live","items":[{"name":"a"},{"name":"b"}],"counts":{"active":2}}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "")
	s.sessionsChecked, s.sessionAPI = true, true

	s.loadMemory()
	waitForNoFrame(t, s, "记忆账本落地", func() bool { return s.memoryActiveCount() == 2 })
}

// wake 必须把「推进状态」交给主线程队列，而不是自己在后台 goroutine 上改状态。
// 这是唯一同时满足「不依赖画帧」与「状态只在一个线程上改」的写法。
func TestWakeHandsTheDrainToTheMainThread(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.arrived <- &Conversation{SessionID: "main", Messages: []Message{{ID: "a1", Text: "到了"}}}

	var handed []func()
	s.bindPost(func(fn func()) { handed = append(handed, fn) })

	s.wake()
	if len(handed) != 1 {
		t.Fatalf("wake 应把一次状态推进交给主线程，实际 %d 次", len(handed))
	}
	if s.conversation != nil {
		t.Fatalf("wake 自己就把状态改了：这一步该留给主线程")
	}

	// 主线程拿到这个任务之后才落状态。
	handed[0]()
	if s.conversation == nil || len(s.conversation.Messages) != 1 {
		t.Fatalf("主线程跑了那个任务却没落状态：%+v", s.conversation)
	}
}

// 反向验证：不跑主线程队列，状态就必须原地不动。
// 这条保证上面那几条不是靠别的路径顺带绿掉的。
func TestStateStaysPutUntilTheMainThreadRuns(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.arrived <- &Conversation{SessionID: "main", Messages: []Message{{ID: "a1", Text: "到了"}}}

	s.wake()
	if s.conversation != nil {
		t.Fatalf("没跑主线程队列，状态却变了：%+v", s.conversation)
	}

	s.runPending()
	if s.conversation == nil || len(s.conversation.Messages) != 1 {
		t.Fatalf("跑了主线程队列却没落状态：%+v", s.conversation)
	}
}

// 调试口那条路走同一个机制：pumpResults 之后 state.dump 与真值一致。
func TestPumpResultsUsesTheSameQueue(t *testing.T) {
	backend, _, s := guiFixture(t)
	s.refresh()
	waitForNoFrame(t, s, "先验回来", func() bool { return s.sessionsChecked && s.sessionAPI })

	want := len(backend.timeline("main"))
	settled := s.pumpResults(3*time.Second, func() bool {
		return s.conversation != nil && len(s.conversation.Messages) == want
	})
	if !settled {
		t.Fatal("pumpResults 没等到时间线落地")
	}
	if got := s.stateSnapshot()["messages"]; got != want {
		t.Fatalf("state.dump 的 messages = %v，应为 %d", got, want)
	}
}

// 一个 app 的队列是它自己的：两个 app 互不串。
func TestQueuesArePerApp(t *testing.T) {
	a, _ := sessionApp(t)
	b, _ := sessionApp(t)
	var ran []string
	a.postMain(func() { ran = append(ran, "a") })
	b.postMain(func() { ran = append(ran, "b") })

	a.runPending()
	if len(ran) != 1 || ran[0] != "a" {
		t.Fatalf("a.runPending 跑了 %v，只该跑自己的那一个", ran)
	}
	b.runPending()
	if len(ran) != 2 || ran[1] != "b" {
		t.Fatalf("b.runPending 之后是 %v", ran)
	}
}

// 有窗口队列时，任务必须交给它而不是自己攒着：否则生产里就成了两套队列。
func TestPostMainPrefersTheWindowQueue(t *testing.T) {
	s, _ := sessionApp(t)
	ran := 0
	s.bindPost(func(fn func()) { ran++; fn() })

	s.postMain(func() { ran++ })
	if ran != 2 {
		t.Fatalf("postMain 没走窗口队列：ran=%d", ran)
	}
	s.runPending()
	if ran != 2 {
		t.Fatalf("走了窗口队列又跑了一遍本地队列：ran=%d", ran)
	}
}

// 绑窗口之前到达的结果不能丢：bindPost 要把它们立刻倒给窗口队列。
// 启动那一小段（WhenReady 之前）就属于这段窗口期。
func TestBindPostFlushesWhatArrivedBeforeIt(t *testing.T) {
	s, _ := sessionApp(t)
	ran := 0
	s.postMain(func() { ran++ })
	if ran != 0 {
		t.Fatalf("没绑窗口就跑掉了：ran=%d", ran)
	}

	var flushed int
	s.bindPost(func(fn func()) { flushed++; fn() })
	if flushed != 1 || ran != 1 {
		t.Fatalf("bindPost 没把攒下的任务倒出来：flushed=%d ran=%d", flushed, ran)
	}
	// 倒过之后本地队列必须空，否则同一件事会被跑两遍。
	s.runPending()
	if ran != 1 {
		t.Fatalf("本地队列还留着旧任务：ran=%d", ran)
	}
}
