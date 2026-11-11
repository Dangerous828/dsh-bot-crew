package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 常规任务那一栏读的是后端的 `GET /api/mobile/routines`（契约 §5.5）。
// 三种 state 分得开不开，是这一栏的全部分寸：读不到不能说成没有。
func serveRoutines(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-crew-credential"); got != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/api/mobile/routines" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

// routineView 解一份线上字节，用来钉住客户端的 JSON 形状（字段名拼错在这里就会红）。
func routineView(t *testing.T, server *httptest.Server) (*RoutinesView, error) {
	t.Helper()
	return New(server.URL, "secret", "").Routines(context.Background())
}

// 这一栏的每一格都来自后端的原话：周期、开关、上次跑、下次跑。
// 客户端不自己算时间，也不替没有 last_run 的那条编一个日期。
func TestRoutinesDecodeWhatTheSurfaceSends(t *testing.T) {
	server := serveRoutines(t, `{
	  "items": [
	    {"id": "daily-standup", "title": "每天站会", "cycle": "daily", "bot_id": "lead", "enabled": true,
	     "created_at": "2026-11-11T09:00:00.000Z", "next_run": "2026-11-12T09:00:00.000Z", "overdue": false},
	    {"id": "weekly-review", "title": "周报", "cycle": "weekly", "enabled": false,
	     "created_at": "2026-11-01T09:00:00.000Z", "last_run": "2026-11-08T09:00:00.000Z",
	     "next_run": "2026-11-15T09:00:00.000Z", "overdue": true}
	  ],
	  "state": "live",
	  "counts": {"enabled": 1, "paused": 1},
	  "runner": "none"
	}`)
	view, err := routineView(t, server)
	if err != nil {
		t.Fatalf("Routines returned an error: %v", err)
	}	if view.State != "live" || len(view.Items) != 2 {
		t.Fatalf("state=%q items=%d", view.State, len(view.Items))
	}
	if view.Items[0].Title != "每天站会" || view.Items[0].BotID != "lead" || view.Items[0].Cycle != "daily" {
		t.Errorf("first item = %+v", view.Items[0])
	}
	if !view.Items[0].Enabled || view.Items[0].Overdue {
		t.Errorf("first item switch = %+v", view.Items[0])
	}
	if view.Items[0].NextRun != "2026-11-12T09:00:00.000Z" {
		t.Errorf("first item next_run = %q", view.Items[0].NextRun)
	}
	// 没跑过的那条不该被解出一个日期：last_run 缺席就是缺席。
	if view.Items[0].LastRun != "" {
		t.Errorf("first item has last_run %q", view.Items[0].LastRun)
	}
	if view.Items[1].LastRun != "2026-11-08T09:00:00.000Z" || !view.Items[1].Overdue || view.Items[1].Enabled {
		t.Errorf("second item = %+v", view.Items[1])
	}
	if view.Counts.Enabled != 1 || view.Counts.Paused != 1 {
		t.Errorf("counts = %+v", view.Counts)
	}
	// 后端还没有调度器：这里不能装成「已排好」。
	if view.Runner != "none" {
		t.Errorf("runner = %q", view.Runner)
	}
}

func TestRoutinesKeepEmptyApartFromUnreadable(t *testing.T) {
	empty := serveRoutines(t, `{"items": [], "state": "empty", "counts": {"enabled": 0, "paused": 0},
	  "reason": "账本里还没有常规任务", "runner": "none"}`)
	view, err := routineView(t, empty)
	if err != nil {
		t.Fatalf("empty ledger returned an error: %v", err)
	}
	if view.State != "empty" || len(view.Items) != 0 {
		t.Fatalf("state=%q items=%d", view.State, len(view.Items))
	}
	if view.Reason == "" {
		t.Error("空态没有说为什么空着")
	}

	gone := serveRoutines(t, `{"items": [], "state": "unavailable", "counts": {"enabled": 0, "paused": 0},
	  "reason": "常规任务的账本读不出来", "runner": "none"}`)
	broken, err := routineView(t, gone)
	if err != nil {
		t.Fatalf("unreadable ledger returned an error: %v", err)
	}
	// 读不到是另一句话，客户端据此写「读不到」，不是「还没有」。
	if broken.State != "unavailable" || broken.Reason == "" {
		t.Fatalf("state=%q reason=%q", broken.State, broken.Reason)
	}
}

func TestRoutinesNoTokenIsAnErrorNotAnEmptyLedger(t *testing.T) {
	server := serveRoutines(t, `{"items": [], "state": "empty", "counts": {"enabled": 0, "paused": 0}}`)
	if _, err := New(server.URL, "wrong", "").Routines(context.Background()); err == nil {
		t.Fatal("凭据不对时应当报错，而不是当成「没有常规任务」")
	}
}

// 上一次、下一次那一行的拼法：两截都没有就整行不画，别留一个孤零零的「 · 」。
func TestRoutineWhenLineSaysOnlyWhatIsKnown(t *testing.T) {
	if got := routineWhenLine("还没跑过", "该跑了（11-11 09:00）"); got != "还没跑过 · 该跑了（11-11 09:00）" {
		t.Errorf("line = %q", got)
	}
	if got := routineWhenLine("", ""); got != "" {
		t.Errorf("line = %q, want empty", got)
	}
	if got := routineWhenLine("上次 11-11 09:00", ""); got != "上次 11-11 09:00" {
		t.Errorf("line = %q", got)
	}
	if got := routineWhenLine("", "关着，不算下一次"); got != "关着，不算下一次" {
		t.Errorf("line = %q", got)
	}
}

// 认不出的时间不显示原始串；三种周期各有一个中文说法，别的原样留着。
func TestRoutineLabelsDoNotInventFacts(t *testing.T) {
	if got := routineTime("昨天"); got != "" {
		t.Errorf("unreadable time = %q, want empty", got)
	}
	if got := routineTime("2026-11-11T09:00:00.000Z"); got == "2026-11-11T09:00:00.000Z" || got == "" {
		t.Errorf("time = %q, want a short local time", got)
	}
	for cycle, want := range map[string]string{"hourly": "每小时", "daily": "每天", "weekly": "每周"} {
		if got := cycleName(cycle); got != want {
			t.Errorf("cycleName(%q) = %q, want %q", cycle, got, want)
		}
	}
	// 不认识的周期不猜成「每天」。
	if got := cycleName("fortnightly"); got != "fortnightly" {
		t.Errorf("cycleName(unknown) = %q", got)
	}
}

// 栏头那行小结只数后端给的 counts，不自己再数一遍。
func TestRoutineSummaryUsesTheCountsTheSurfaceSent(t *testing.T) {
	if got := routineSummary(RoutinesView{Counts: RoutineCounts{Enabled: 2, Paused: 1}}); got != "2 条开着 · 1 条关着" {
		t.Errorf("summary = %q", got)
	}
	if got := routineSummary(RoutinesView{Counts: RoutineCounts{Enabled: 1}}); got != "1 条开着" {
		t.Errorf("summary = %q", got)
	}
	if got := routineSummary(RoutinesView{}); got != "" {
		t.Errorf("summary = %q, want empty", got)
	}
}
