package main

// debug_settled_test.go —— 「慢后端超过主线程等待上限」时，两个动作必须如实说没落定。
//
// 背景：动作体整段跑在主线程上，所以 pumpResults 的等待被 mainThreadSettleCap 封顶。
// session.set / memory.save 原来把 pumpResults 的返回值丢掉了 —— 后端慢到超过上限时
// 回包仍是 ok:true + 旧 loaded / 旧 count，外部脚本读成「切过去了 / 改完了」，
// 这正是要修掉的假完成。现在两处都把 pump 的结果放进 settled。
//
// 这一组的判据是三条，缺一条都不算修好：
//  1. 慢后端 → settled:false，且 loaded / count 报的是**这一刻的真值**（不是编的）；
//  2. 快后端 → settled:true（防止「永远 false」也算修好）；
//  3. settled 是 pumpResults 的结果透传，不是另算一套。
//
// 成本控制：不真等 3s。mainThreadSettleCap 是 var，这里临时调小、用完恢复；
// 假后端只 sleep 到「明显超过上限」，实现本身一行不改、不复制 pumpResults。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// withSettleCap 把主线程等待上限临时调小，测试结束恢复。
// 只动这一个数：不复制 pumpResults，也不改它的实现。
func withSettleCap(t *testing.T, cap time.Duration) {
	t.Helper()
	previous := mainThreadSettleCap
	mainThreadSettleCap = cap
	t.Cleanup(func() { mainThreadSettleCap = previous })
}

// settledOf 取出回包里的 settled 字段，并确认它真的存在（不是零值蒙混）。
func settledOf(t *testing.T, out any) bool {
	t.Helper()
	view, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("回包应是一个对象，实际 %T", out)
	}
	raw, present := view["settled"]
	if !present {
		t.Fatalf("回包没有 settled 字段：%v", view)
	}
	settled, ok := raw.(bool)
	if !ok {
		t.Fatalf("settled 应是布尔，实际 %T", raw)
	}
	return settled
}

// 慢时间线：session.set 在 cap 内等不到 work 的时间线，必须回 settled:false，
// 且 loaded / messages 报的是「work 还没读到」的真值，不能假称切过去那段已读完。
func TestDebugBusSessionSetReportsUnsettledOnSlowTimeline(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/mobile/sessions":
			_, _ = w.Write([]byte(`{"sessions":["main","work"],"default_session_id":"main","session_api":1}`))
		case r.URL.Path == "/api/mobile/timeline":
			// 只拖 work 那一条：切过去之后的读一直不回来。
			if sessionOfRequest(r) == "work" {
				<-release
			}
			_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[],"session_id":"` + sessionOfRequest(r) +
				`","session_api":1,"sessions":["main","work"],"default_session_id":"main"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	defer close(release)

	withSettleCap(t, 60*time.Millisecond)

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	s.client.confirmSessions() // 传输层门禁也要放行非 main，否则 work 那条请求根本不会发
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	bus := newDebugBus(s)

	out, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "work"})
	if err != nil {
		t.Fatalf("session.set: %v", err)
	}
	if settledOf(t, out) {
		t.Fatal("后端慢过主线程上限，却报 settled:true：这就是假称切过去那段已经读完")
	}
	view := out.(map[string]any)
	if view["session"] != "work" {
		t.Errorf("切换本身是真做了的，session 应为 work，实际 %v", view["session"])
	}
	// 真值：work 的时间线一条都没读到（缓存里没有它），不是 0 条也不是旧会话的条数。
	if loaded, _ := view["loaded"].(bool); loaded {
		t.Errorf("work 的时间线还没回来，loaded 却是 true：%v", view)
	}
	if got, _ := view["messages"].(int); got != -1 {
		t.Errorf("work 还没读到，messages 应为 -1，实际 %v", view["messages"])
	}
}

// 慢重读：memory.save 的写入是真的，但重读账本在 cap 内没回来 ——
// settled:false，count 报旧值（这一刻账本里真的是旧值），不假称已刷新。
func TestDebugBusMemorySaveReportsUnsettledOnSlowReload(t *testing.T) {
	release := make(chan struct{})
	var posts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = io.ReadAll(r.Body)
			posts++
			_, _ = w.Write([]byte(`{"ok":true,"name":"bot-lead-a"}`))
			return
		}
		// 重读：第一次（准备阶段）立刻给旧账本，之后一直挂着。
		if posts == 0 {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"state": "live", "items": []map[string]any{{"name": "bot-lead-a", "body": "旧"}},
				"counts": map[string]int{"active": 1},
			})
			return
		}
		// 晚到的重读给一份合法账本：测试结束后它才落地，不阻塞、不报错。
		<-release
		_ = json.NewEncoder(w).Encode(map[string]any{
			"state": "live", "items": []map[string]any{{"name": "bot-lead-a", "body": "新"}},
			"counts": map[string]int{"active": 1},
		})
	}))
	defer server.Close()
	defer close(release)

	withSettleCap(t, 60*time.Millisecond)

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	bus := newDebugBus(s)
	if _, err := invokeRaw(t, bus, "memory.reload", nil); err != nil {
		t.Fatalf("memory.reload: %v", err)
	}
	// 准备阶段用的是真 pumpResults（cap 已调小，但假后端秒回，仍是 settled）。
	if s.memoryActiveCount() != 1 {
		t.Fatalf("准备阶段没读到旧账本：count=%d", s.memoryActiveCount())
	}
	if _, err := invokeRaw(t, bus, "memory.edit", map[string]any{"name": "bot-lead-a", "body": "新"}); err != nil {
		t.Fatalf("memory.edit: %v", err)
	}

	out, err := invokeRaw(t, bus, "memory.save", nil)
	if err != nil {
		t.Fatalf("memory.save: %v", err)
	}
	if settledOf(t, out) {
		t.Fatal("账本重读还没回来，却报 settled:true：这就是假称改完已刷新")
	}
	view := out.(map[string]any)
	if view["saved"] != "bot-lead-a" {
		t.Errorf("写入本身是真的，saved 应为 bot-lead-a，实际 %v", view["saved"])
	}
	// 真值：账本还没重读回来，count 报的是这一刻的旧值 1，不是编一个新值。
	if got, _ := view["count"].(int); got != 1 {
		t.Errorf("重读没回来时 count 应是旧值 1，实际 %v", view["count"])
	}
	if posts != 1 {
		t.Errorf("应恰好发一次 POST /memory，实际 %d 次", posts)
	}
	// 编辑层已关（写入成功），不是「没保存」——两件事分开报。
	if s.actions.editingMemory != "" {
		t.Errorf("保存成功后编辑层没关：%q", s.actions.editingMemory)
	}
}

// 正向对照：后端秒回时两个动作都必须报 settled:true。
// 没有这条，「永远 false」也能让上面两条绿 —— 那是另一种假。
func TestDebugBusSessionSetAndMemorySaveReportSettledOnFastBackend(t *testing.T) {
	var saved []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/mobile/sessions":
			_, _ = w.Write([]byte(`{"sessions":["main","work"],"default_session_id":"main","session_api":1}`))
		case r.URL.Path == "/api/mobile/timeline":
			session := sessionOfRequest(r)
			items := `[]`
			if session == "work" {
				items = `[{"id":"w1","role":"user","text":"工作线第一句"}]`
			}
			_, _ = w.Write([]byte(`{"items":` + items + `,"bots":[],"tasks":[],"session_id":"` + session +
				`","session_api":1,"sessions":["main","work"],"default_session_id":"main"}`))
		case r.Method == http.MethodPost:
			_, _ = io.ReadAll(r.Body)
			saved = append(saved, map[string]any{"ok": true})
			_, _ = w.Write([]byte(`{"ok":true,"name":"bot-lead-a"}`))
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"state": "live", "items": []map[string]any{{"name": "bot-lead-a", "body": "旧"}},
				"counts": map[string]int{"active": 1},
			})
		}
	}))
	defer server.Close()

	s, _ := sessionApp(t)
	s.client = New(server.URL, "secret", "crew-desktop")
	s.client.confirmSessions() // 传输层门禁也要放行非 main，否则 work 那条请求根本不会发
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	bus := newDebugBus(s)

	out, err := invokeRaw(t, bus, "session.set", map[string]any{"session": "work"})
	if err != nil {
		t.Fatalf("session.set: %v", err)
	}
	if !settledOf(t, out) {
		t.Fatalf("后端秒回却报 settled:false：%v", out)
	}
	view := out.(map[string]any)
	if loaded, _ := view["loaded"].(bool); !loaded {
		t.Errorf("settled 之后 loaded 应为 true：%v", view)
	}
	if got, _ := view["messages"].(int); got != 1 {
		t.Errorf("settled 之后 messages 应是 work 的 1 条，实际 %v", view["messages"])
	}

	if _, err := invokeRaw(t, bus, "memory.reload", nil); err != nil {
		t.Fatalf("memory.reload: %v", err)
	}
	if _, err := invokeRaw(t, bus, "memory.edit", map[string]any{"name": "bot-lead-a", "body": "新"}); err != nil {
		t.Fatalf("memory.edit: %v", err)
	}
	out, err = invokeRaw(t, bus, "memory.save", nil)
	if err != nil {
		t.Fatalf("memory.save: %v", err)
	}
	if !settledOf(t, out) {
		t.Fatalf("后端秒回却报 settled:false：%v", out)
	}
	if len(saved) != 1 {
		t.Errorf("应恰好发一次 POST /memory，实际 %d 次", len(saved))
	}
}
