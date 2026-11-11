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

// 成本那一句：没上报的步数必须写出来，「读不到」绝不能写成 0。
func TestSpendLineKeepsUnaccountedStepsVisible(t *testing.T) {
	if got := spendLine(nil); got != "用量：没有模型调用记录" {
		t.Fatalf("nil: %q", got)
	}
	spend := &Spend{StepCount: 3, InputTokens: 1200, OutputTokens: 300, TotalTokens: 1500, UnaccountedSteps: 1}
	if got := spendLine(spend); !strings.Contains(got, "1 步没有上报") {
		t.Fatalf("unaccounted must show: %q", got)
	}
	clean := &Spend{StepCount: 1, InputTokens: 10, OutputTokens: 5, TotalTokens: 15}
	if got := spendLine(clean); strings.Contains(got, "没有上报") {
		t.Fatalf("clean spend should not mention unaccounted: %q", got)
	}
}

func TestCompactTokens(t *testing.T) {
	for value, want := range map[int]string{0: "0", 999: "999", 1200: "1.2k", 1_500_000: "1.5M"} {
		if got := compactTokens(value); got != want {
			t.Fatalf("%d: %q != %q", value, got, want)
		}
	}
}

// 审计那一句缺什么就不说，不替它编。
func TestAuditLineSaysWhatIsMissing(t *testing.T) {
	row := &AuditRow{}
	row.RequestedBy.Via = "routine"
	row.Judged = []byte(`"unrecorded"`)
	line := auditLine(row)
	if !strings.Contains(line, "到点派的") || !strings.Contains(line, "没有裁决记录") || !strings.Contains(line, "还没派人做") {
		t.Fatalf("auditLine: %q", line)
	}
	withDecision := &AuditRow{}
	withDecision.Judged = []byte(`{"outcome":"accept"}`)
	withDecision.WorkedBy.Bot = "lead"
	if got := auditLine(withDecision); !strings.Contains(got, "判为 accept") || !strings.Contains(got, "由 lead 做") {
		t.Fatalf("with decision: %q", got)
	}
}

// 空态框里那个符号跟着标题走：三处空态各有自己的记号，别都画成一个圈。
func TestGlyphOfNamesEachEmptyState(t *testing.T) {
	cases := map[string]string{
		"还没有产出":   "▤",
		"还没有常规任务": "◷",
		"还没有记住什么": "◇",
		"别的东西":    "◌",
	}
	for title, want := range cases {
		if got := glyphOf(title); got != want {
			t.Fatalf("%q: %q != %q", title, got, want)
		}
	}
}

// 空态与读不到是两件事：前者用虚线框（这里还没有东西），后者用实线框（读不出来）。
// 这条钉住 emptyCopy 只在真的「一条都没有」时才给得出标题 —— 别处不该拿它冒充。
func TestEmptyCopyOnlySpeaksForReallyEmptyPanes(t *testing.T) {
	for _, item := range navOrder {
		title, body := emptyCopy(item)
		if item == navMemory || item == navOutput || item == navRoutine {
			if title == "" || body == "" {
				t.Fatalf("%v should have empty copy", item)
			}
			// 空态原话里不许出现「读不到」：那是另一件事的词。
			if strings.Contains(title, "读不到") || strings.Contains(body, "读不到") {
				t.Fatalf("%v empty copy must not say unreadable: %q / %q", item, title, body)
			}
		}
	}
}

func TestMin32(t *testing.T) {
	if min32(3, 5) != 3 || min32(5, 3) != 3 || min32(4, 4) != 4 {
		t.Fatal("min32 must return the smaller one")
	}
}
