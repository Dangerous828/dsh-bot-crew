package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 记忆这一栏的三态与文字：读不到绝不写成「没有」，忘掉的条目不消失。
func TestMemorySummaryCountsEveryState(t *testing.T) {
	if got := memorySummary(MemoryView{Counts: MemoryCounts{Active: 3}}); got != "记得 3 条" {
		t.Fatalf("only active: %q", got)
	}
	if got := memorySummary(MemoryView{Counts: MemoryCounts{Active: 1, Forgotten: 2, Superseded: 3}}); got != "记得 1 条 · 忘掉 2 · 被替代 3" {
		t.Fatalf("all states: %q", got)
	}
}

func TestMemoryTitlePrefersDescriptionThenBody(t *testing.T) {
	item := MemoryItem{Name: "bot-lead-x", Description: "先说结论", Body: "正文第一句。\n\n第二段。"}
	if got := memoryTitle(item); got != "先说结论" {
		t.Fatalf("description first: %q", got)
	}
	item.Description = ""
	if got := memoryTitle(item); got != "正文第一句。" {
		t.Fatalf("body first paragraph: %q", got)
	}
	item.Body = ""
	if got := memoryTitle(item); got != "bot-lead-x" {
		t.Fatalf("name last: %q", got)
	}
}

func TestMemoryBriefSkipsEmptyFirstParagraph(t *testing.T) {
	if got := memoryBrief("\n\n  \n\n真正的第一段"); got != "真正的第一段" {
		t.Fatalf("blank paragraphs skipped: %q", got)
	}
	long := strings.Repeat("字", 200)
	if got := memoryBrief(long); !strings.HasSuffix(got, "…") {
		t.Fatalf("long body should be cut: %q", got)
	}
}

func TestMemoryDetailNamesSource(t *testing.T) {
	item := MemoryItem{BotID: "lead", Origin: "person:owner", Updated: 1794000000}
	if got := memoryDetail(item); !strings.HasPrefix(got, "lead · 你说的 · ") {
		t.Fatalf("person origin: %q", got)
	}
	item = MemoryItem{Origin: "ticket:t1"}
	if got := memoryDetail(item); got != "全队 · 工单结论" {
		t.Fatalf("ticket origin without bot: %q", got)
	}
}

// 客户端契约：GET 带 bot 过滤，POST 带 action。
func TestMemoryClientRoundTrip(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"state":"live","items":[{"name":"bot-lead-a","bot_id":"lead","body":"b","state":"active"}],"counts":{"active":1}}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := New(server.URL, "token", "")
	view, err := client.Memory(context.Background(), "lead")
	if err != nil {
		t.Fatalf("memory: %v", err)
	}
	if view.State != "live" || len(view.Items) != 1 || !view.Items[0].Active() {
		t.Fatalf("view: %+v", view)
	}
	if err := client.ForgetMemory(context.Background(), "bot-lead-a"); err != nil {
		t.Fatalf("forget: %v", err)
	}
	if len(seen) != 2 || !strings.Contains(seen[0], "GET /api/mobile/memory") || !strings.Contains(seen[0], "bot=lead") {
		t.Fatalf("requests: %v", seen)
	}
	if seen[1] != "POST /api/mobile/memory?" {
		t.Fatalf("forget request: %s", seen[1])
	}
}
