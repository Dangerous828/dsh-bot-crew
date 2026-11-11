package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 插队：带票号和请求号去交，409 是「已经读走了」而不是网络故障。
func TestSteerSendsTheTicketAndRequest(t *testing.T) {
	var sent map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/mobile/steer" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	if err := New(server.URL, "secret", "").Steer(t.Context(), "t1", "r1"); err != nil {
		t.Fatalf("Steer: %v", err)
	}
	if sent["ticket"] != "t1" || sent["request_id"] != "r1" {
		t.Errorf("sent = %v", sent)
	}

	late := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusConflict) }))
	t.Cleanup(late.Close)
	if err := New(late.URL, "secret", "").Steer(t.Context(), "t1", "r1"); !errors.Is(err, ErrSteerTooLate) {
		t.Errorf("409 应该是 ErrSteerTooLate，实际 %v", err)
	}
}

// 有工单在跑、有排队消息时，界面上要能点「插队」；没有在跑的票就不摆这个按钮。
func TestSteerButtonAppearsOnlyWhileATicketRuns(t *testing.T) {
	posted := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/steer":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			posted <- body
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/mobile/timeline":
			_, _ = w.Write([]byte(`{"items":[],"tasks":[],"queued":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = &Conversation{
		Queued:   []string{"r1"},
		Messages: []Message{{ID: "m1", Role: "user", RequestID: "r1", Text: "先看这一条"}},
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 746)
	tt.Frame()
	if _, ok := tt.Find("插队"); ok {
		t.Fatal("没有在跑的工单时不该出现「插队」")
	}
	s.conversation.Tasks = []Task{{ID: "t1", Title: "在做", Open: true}}
	tt.Frame()
	if _, ok := tt.Find("插队"); !ok {
		t.Fatalf("有工单在跑时应该能插队；画的是 %v", tt.Texts())
	}
	tt.Click("插队")
	select {
	case body := <-posted:
		if body["ticket"] != "t1" || body["request_id"] != "r1" {
			t.Fatalf("提交的是 %v", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("点了插队却没有提交")
	}
}

// 有工单在跑时，输入框里这句可以「插队」直接发；没有在跑的票就不摆这个按钮。
func TestComposerCanSendANewLineStraightIntoTheRunningTicket(t *testing.T) {
	posted := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/steer":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			posted <- body
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/mobile/timeline":
			_, _ = w.Write([]byte(`{"items":[],"tasks":[],"queued":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = &Conversation{Tasks: []Task{{ID: "t1", Title: "在做", Open: true}}}
	s.input = "顺便看一眼"
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 746)
	tt.Frame()
	if _, ok := tt.Find("插队"); !ok {
		t.Fatalf("输入框有字、工单在跑时应该能插队；画的是 %v", tt.Texts())
	}
	tt.Click("插队")
	select {
	case body := <-posted:
		if body["ticket"] != "t1" || body["text"] != "顺便看一眼" || body["request_id"] == "" {
			t.Fatalf("提交的是 %v", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("点了插队却没有提交")
	}
}
