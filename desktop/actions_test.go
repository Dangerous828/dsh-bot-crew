package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 入口 1：编辑按钮把标题和正文一起交给已有的 Client.EditMemory。
func TestEditMemorySendsDescriptionAndBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/mobile/memory" {
			t.Errorf("打错端点了：%s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); !strings.Contains(got, "application/json") {
			t.Errorf("记忆编辑必须是 JSON：%q", got)
		}
		raw, _ := io.ReadAll(r.Body)
		var asked map[string]string
		if err := json.Unmarshal(raw, &asked); err != nil {
			t.Fatalf("读不懂请求：%v", err)
		}
		for key, want := range map[string]string{
			"action": "edit", "name": "bot-lead-a", "description": "新标题", "body": "新正文",
		} {
			if asked[key] != want {
				t.Errorf("%s = %q，要 %q", key, asked[key], want)
			}
		}
		_, _ = w.Write([]byte(`{"ok":true,"name":"bot-lead-a"}`))
	}))
	defer server.Close()
	if err := New(server.URL, "token", "").EditMemory(context.Background(), "bot-lead-a", "新标题", "新正文"); err != nil {
		t.Fatalf("edit: %v", err)
	}
}

// 入口 1：后端回 ok:false 时编辑层不能关，reason 要留在层里给人看。
func TestSaveMemoryRefusalShowsBackendReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":false,"reason":"后端还没有接入记忆"}`))
	}))
	defer server.Close()
	s := &app{client: New(server.URL, "token", ""), actions: newActionState()}
	s.editMemory(MemoryItem{Name: "bot-lead-a", Description: "旧标题", Body: "旧正文"})
	s.actions.memoryDescription, s.actions.memoryBody = "新标题", "新正文"
	s.saveMemory()

	select {
	case result := <-s.actions.results:
		s.applyAction(result)
	case <-time.After(3 * time.Second):
		t.Fatal("编辑结果没有回到主线程")
	}
	a := s.actions
	if a.editingMemory != "bot-lead-a" {
		t.Fatalf("失败后编辑层被关掉了：%q", a.editingMemory)
	}
	if !strings.Contains(a.memoryEditError, "后端还没有接入记忆") {
		t.Errorf("没把后端 reason 显示出来：%q", a.memoryEditError)
	}
	if a.memorySaving {
		t.Error("失败之后还卡在「保存中」")
	}
}

// 入口 1：成功才关层、才重读；取消与旧回执都不该假装改完了。
func TestMemoryEditOutcomes(t *testing.T) {
	t.Run("success closes and clears", func(t *testing.T) {
		s := &app{actions: newActionState()}
		a := s.actions
		a.editingMemory, a.memoryDescription, a.memoryBody = "bot-lead-a", "标题", "正文"
		a.memorySaving, a.memoryEditError = true, "上次的错"
		s.applyAction(actionResult{kind: "memory", name: "bot-lead-a", ok: true})
		if a.editingMemory != "" || a.memoryDescription != "" || a.memoryBody != "" || a.memoryEditError != "" || a.memorySaving {
			t.Fatalf("成功后没把编辑层收干净：%+v", a)
		}
	})
	t.Run("stale result ignored", func(t *testing.T) {
		s := &app{actions: newActionState()}
		a := s.actions
		a.editingMemory, a.memorySaving = "bot-lead-a", true
		s.applyAction(actionResult{kind: "memory", name: "bot-other", ok: true})
		if a.editingMemory != "bot-lead-a" || !a.memorySaving {
			t.Fatal("另一条记忆的旧回执把这一条关掉了")
		}
	})
	t.Run("cancel clears draft", func(t *testing.T) {
		s := &app{actions: newActionState()}
		s.editMemory(MemoryItem{Name: "bot-lead-a", Description: "标题", Body: "正文"})
		s.actions.memorySaving, s.actions.memoryEditError = true, "某次失败"
		s.cancelMemoryEdit()
		a := s.actions
		if a.editingMemory != "" || a.memoryDescription != "" || a.memoryBody != "" || a.memoryEditError != "" || a.memorySaving {
			t.Fatalf("取消没把草稿和错误收干净：%+v", a)
		}
		// 取消之后保存不该再发请求：client 为 nil 时 saveMemory 直接返回。
		s.saveMemory()
	})
}

// 语音识别出来的字只进草稿：applyAction 不该顺手把它发出去。
func TestVoiceResultOnlyFillsDraft(t *testing.T) {
	s := &app{actions: newActionState(), input: "已经打了一半 "}
	s.applyAction(actionResult{kind: "voice", state: "", note: "识别好了", text: "把周报发我", ok: true})
	if s.input != "已经打了一半 把周报发我" {
		t.Errorf("草稿不对：%q", s.input)
	}
	if s.sending {
		t.Error("识别结果被自动发出去了")
	}
	if s.problem != "" {
		t.Error("识别结果写成了全局故障横幅")
	}
}

func TestMergeDraft(t *testing.T) {
	for _, tc := range []struct{ existing, recognized, want string }{
		{"", "你好", "你好"},
		{"", "  ", ""},
		{"前半句", "后半句", "前半句 后半句"},
		{"前半句 ", "后半句", "前半句 后半句"},
		{"前半句，", "后半句", "前半句，后半句"},
	} {
		if got := mergeDraft(tc.existing, tc.recognized); got != tc.want {
			t.Errorf("mergeDraft(%q,%q) = %q，要 %q", tc.existing, tc.recognized, got, tc.want)
		}
	}
}
