package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 入口 3：接手的回执必须按后端真实返回值说，缺一个字段都不能算接上了。
func TestParseTakeoverStrict(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		wantNote string
		wantOK   bool
	}{
		{"stopped", 200, `{"ok":true,"stopped":true}`, "已接手：这张票停下了", true},
		{"ok without stopped", 200, `{"ok":true}`, "没确认这张票停下", false},
		{"stopped without ok", 200, `{"stopped":true}`, "后端没有确认接手", false},
		{"explicit false", 200, `{"ok":false,"stopped":false}`, "后端没有确认接手", false},
		{"empty object", 200, `{}`, "后端没有确认接手", false},
		{"no such ticket", 404, `{"error":"No such ticket"}`, "No such ticket", false},
		{"cannot be stopped", 409, `{"error":"Ticket cannot be stopped"}`, "Ticket cannot be stopped", false},
		{"ticket required", 400, `{"error":"ticket is required"}`, "ticket is required", false},
		{"engine unavailable", 503, `{"error":"Ticket control is unavailable"}`, "Ticket control is unavailable", false},
		{"unreadable body", 200, `not json`, "读不懂接手回执", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ack, err := parseTakeover(tc.status, []byte(tc.body))
			note := takeoverNote(ack, err)
			if !strings.Contains(note, tc.wantNote) {
				t.Errorf("回执说得不对：%q，要含 %q", note, tc.wantNote)
			}
			if got := takeoverOK(ack, err); got != tc.wantOK {
				t.Errorf("takeoverOK = %v，要 %v", got, tc.wantOK)
			}
		})
	}
}

// 入口 3：客户端把票号发到 /api/mobile/takeover，成功回执原样带回来。
func TestClientTakeoverSendsTicket(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/mobile/takeover" {
			t.Errorf("打错端点了：%s %s", r.Method, r.URL.Path)
		}
		var asked map[string]string
		if err := json.NewDecoder(r.Body).Decode(&asked); err != nil || asked["ticket"] != "T-1" {
			t.Errorf("票号不对：%v %v", asked, err)
		}
		_, _ = w.Write([]byte(`{"ok":true,"stopped":true}`))
	}))
	defer server.Close()
	ack, err := New(server.URL, "token", "").Takeover(context.Background(), "T-1")
	if err != nil {
		t.Fatalf("Takeover: %v", err)
	}
	if !takeoverOK(ack, err) {
		t.Fatal("成功回执没被认出来")
	}
}

// 入口 3：后端拒绝或回执缺字段时，UI 收到的那句话不能冒充「已接手」。
func TestTakeoverRefusalIsShownAsRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"Ticket cannot be stopped"}`))
	}))
	defer server.Close()
	s := &app{client: New(server.URL, "token", ""), actions: newActionState()}
	s.takeoverTask(Task{ID: "T-1", Open: true})
	select {
	case result := <-s.actions.results:
		if result.ok || strings.Contains(result.note, "已接手：") {
			t.Errorf("拒绝被说成了接手：%+v", result)
		}
		if !strings.Contains(result.note, "Ticket cannot be stopped") {
			t.Errorf("没把后端原因带回来：%q", result.note)
		}
		s.applyAction(result)
		if s.actions.takeoverBusy["T-1"] {
			t.Error("接手中没松开")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("接手结果没有回到主线程")
	}
}

// 入口 3：没活儿（票已结束 / 没连上）时不发请求，也不写「已接手」。
func TestTakeoverNoWorkIsHonest(t *testing.T) {
	s := &app{actions: newActionState()}
	s.takeoverTask(Task{ID: "T-done", Open: false})
	if note := s.actions.takeoverNote["T-done"]; !strings.Contains(note, "没有可接手的活儿") {
		t.Errorf("已结束的票没如实说：%q", note)
	}
	if len(s.actions.results) != 0 {
		t.Error("没活儿还往主线程塞了一个结果")
	}
	s.takeoverTask(Task{ID: "T-open", Open: true})
	if note := s.actions.takeoverNote["T-open"]; !strings.Contains(note, "还没连上队伍") {
		t.Errorf("没连上没如实说：%q", note)
	}
}

// applyAction 的接手分支：只有 ok 才要求刷新时间线，回执按票存。
func TestApplyActionTakeoverKeepsNotesPerTicket(t *testing.T) {
	s := &app{actions: newActionState()}
	a := s.actions
	a.takeoverBusy["T-1"] = true
	s.applyAction(actionResult{kind: "takeover", name: "T-1", note: "后端没有确认接手", ok: false})
	if a.takeoverNote["T-1"] != "后端没有确认接手" || a.takeoverBusy["T-1"] {
		t.Fatalf("回执没按票存 / 没松开：%+v", a)
	}
	s.applyAction(actionResult{kind: "takeover", name: "T-2", note: "已接手：这张票停下了", ok: true})
	if a.takeoverNote["T-1"] != "后端没有确认接手" {
		t.Error("另一张票的结果把这一张的回执盖掉了")
	}
}
