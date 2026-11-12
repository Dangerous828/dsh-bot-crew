package main

// debug_test.go —— 验证全局调试态：
//   ① 进程内动作总线：按名字调，状态真的变；未知动作明确报错。
//   ② 控制口（unix socket）：一条 JSON 进、一条 JSON 出，往返正确。
//
// 这里不碰真实后端：动作只改 app 的界面状态（nav / selectedBot / sidebar …），
// 需要网络的（send / refresh / loadXxx）在没 client 时安全返回，不作为本测试重点。

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func raw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// 进程内：导航动作真的把界面切过去了，state.dump 读得回这份变化。
func TestDebugBusNavigatesAndDumpsState(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)

	// newApp 默认停在事务板且右栏展开；按一次「后台」切过去，再按一次才是「收起」。
	if s.navTab != navBoard || !s.backendOpen {
		t.Fatalf("newApp 默认应停在事务板且展开，实际 navTab=%v backendOpen=%v", s.navTab, s.backendOpen)
	}
	if _, err := bus.invoke("nav.backend", map[string]json.RawMessage{}); err != nil {
		t.Fatalf("nav.backend: %v", err)
	}
	if s.navTab != navBackend || !s.backendOpen {
		t.Fatalf("按一次后台应切到后台且展开，实际 navTab=%v backendOpen=%v", s.navTab, s.backendOpen)
	}
	if _, err := bus.invoke("nav.backend", map[string]json.RawMessage{}); err != nil {
		t.Fatalf("nav.backend 第二次: %v", err)
	}
	if s.backendOpen {
		t.Fatalf("已在后台再按一次应收起右栏，实际 backendOpen=%v", s.backendOpen)
	}

	// 切到常规任务：navTab 变成 routine，state.dump 里 nav 也应是 routines。
	if _, err := bus.invoke("nav.routines", map[string]json.RawMessage{}); err != nil {
		t.Fatalf("nav.routines: %v", err)
	}
	if s.navTab != navRoutine {
		t.Fatalf("按常规任务之后 navTab 应为 navRoutine，实际 %v", s.navTab)
	}
	dump, err := bus.invoke("state.dump", map[string]json.RawMessage{})
	if err != nil {
		t.Fatalf("state.dump: %v", err)
	}
	snap := dump.(map[string]any)
	if snap["nav"] != "routines" {
		t.Fatalf("state.dump 的 nav 应为 routines，实际 %v", snap["nav"])
	}
	if snap["backendOpen"] != true {
		t.Fatalf("state.dump 的 backendOpen 应为 true，实际 %v", snap["backendOpen"])
	}
}

// 进程内：未知动作明确报错，不静默成功。
func TestDebugBusUnknownActionFails(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)
	if _, err := bus.invoke("does.not.exist", nil); err == nil {
		t.Fatal("未知动作应报错，实际没有")
	}
}

// 进程内：参数类型错/缺参数都拒绝，不把坏输入当成默认值悄悄吞掉。
func TestDebugBusRejectsBadArgs(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)

	// backend.tab 越界。
	if _, err := bus.invoke("backend.tab", map[string]json.RawMessage{"index": raw(t, 9)}); err == nil {
		t.Fatal("backend.tab index=9 应报错")
	}
	// sidebar.width 非正数。
	if _, err := bus.invoke("sidebar.width", map[string]json.RawMessage{"px": raw(t, -5)}); err == nil {
		t.Fatal("sidebar.width px=-5 应报错")
	}
	// send 缺 text。
	if _, err := bus.invoke("send", map[string]json.RawMessage{}); err == nil {
		t.Fatal("send 缺 text 应报错")
	}
}

// 进程内：sidebar.width / selectBot / backend.tab 都真的改了对应字段。
func TestDebugBusMutatesUiFields(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)

	if _, err := bus.invoke("sidebar.width", map[string]json.RawMessage{"px": raw(t, 180)}); err != nil {
		t.Fatalf("sidebar.width: %v", err)
	}
	if s.sidebarWidth != 180 {
		t.Fatalf("sidebarWidth 应为 180，实际 %v", s.sidebarWidth)
	}

	if _, err := bus.invoke("nav.selectBot", map[string]json.RawMessage{"bot_id": raw(t, "lead")}); err != nil {
		t.Fatalf("nav.selectBot: %v", err)
	}
	if s.selectedBot != "lead" {
		t.Fatalf("selectedBot 应为 lead，实际 %q", s.selectedBot)
	}

	if _, err := bus.invoke("backend.tab", map[string]json.RawMessage{"index": raw(t, 2)}); err != nil {
		t.Fatalf("backend.tab: %v", err)
	}
	if s.backendTab != 2 || s.navTab != navBackend || !s.backendOpen {
		t.Fatalf("backend.tab=2 后应停在后台第 2 档，实际 tab=%v nav=%v open=%v", s.backendTab, s.navTab, s.backendOpen)
	}
}

// actions.list 至少列出导航那几项与 state.dump —— 让人/脚本发现能调什么。
func TestDebugBusListsActions(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)
	out, err := bus.invoke("actions.list", map[string]json.RawMessage{})
	if err != nil {
		t.Fatalf("actions.list: %v", err)
	}
	names := out.(map[string]any)["actions"].([]string)
	has := map[string]bool{}
	for _, n := range names {
		has[n] = true
	}
	for _, want := range []string{"nav.routines", "nav.memory", "send", "state.dump", "actions.list"} {
		if !has[want] {
			t.Fatalf("动作表里缺 %q，实际有 %v", want, names)
		}
	}
}

// unix socket 往返：起服务、用客户端发一条，拿回 ok:true 与结果。
func TestDebugSocketRoundTrip(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "crew-debug.sock")
	t.Setenv("CREW_DEBUG_SOCK", sock)

	s := newApp(New("http://127.0.0.1:1", "t", ""))
	bus := newDebugBus(s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := bus.serveDebug(ctx); err != nil {
		t.Fatalf("serveDebug: %v", err)
	}
	// 等 socket 落盘。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	resp, err := debugClient("nav.routines", map[string]any{})
	if err != nil {
		t.Fatalf("debugClient: %v", err)
	}
	if resp["ok"] != true {
		t.Fatalf("往返应 ok:true，实际 %v", resp)
	}
	if s.navTab != navRoutine {
		t.Fatalf("经 socket 调 nav.routines 后应停在常规任务，实际 %v", s.navTab)
	}

	// 同一连接再发一条 state.dump（服务是「一行一请求」长连接）。
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	for _, action := range []string{"nav.memory", "state.dump"} {
		if err := enc.Encode(map[string]any{"action": action}); err != nil {
			t.Fatalf("encode %s: %v", action, err)
		}
		var got map[string]any
		if err := dec.Decode(&got); err != nil {
			t.Fatalf("decode %s: %v", action, err)
		}
		if got["ok"] != true {
			t.Fatalf("%s 应 ok:true，实际 %v", action, got)
		}
		if action == "state.dump" {
			result := got["result"].(map[string]any)
			if result["nav"] != "memory" {
				t.Fatalf("dump 的 nav 应为 memory，实际 %v", result["nav"])
			}
		}
	}
}
