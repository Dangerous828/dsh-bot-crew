package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// timelineJSON is a slice of what the message surface actually returns, captured from the gateway: two people's
// messages and one Bot reply, plus a field this client does not know about.
const timelineJSON = `{
  "items": [
    {"id": "m1", "role": "user", "text": "@写手 你好", "at": "2026-11-09T11:47:23.000Z", "request_id": "r-1"},
    {"id": "r1", "role": "agent", "bot_id": "scribbler", "text": "在的", "at": "2026-11-09T11:47:31.000Z"},
    {"id": "m2", "role": "user", "text": "还有人吗", "at": "2026-11-09T11:48:02.000Z", "future_field": {"n": 1}}
  ],
  "bots": [
    {"id": "lead", "name": "大哥", "role": "default"},
    {"id": "scribbler", "name": "写手", "role": "member", "persona": "负责文案"}
  ],
  "default_bot_id": "lead",
  "tasks": [],
  "status": {"runtime": "ready", "mobile": "on", "paused": false}
}`

func serve(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-GW-Token"); got != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/api/mobile/timeline" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestTimelineReadsBothSidesOfTheConversation(t *testing.T) {
	server := serve(t, timelineJSON)
	client := New(server.URL, "secret", "")

	conversation, err := client.Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline returned an error: %v", err)
	}
	if len(conversation.Messages) != 3 {
		t.Fatalf("got %d messages, want 3", len(conversation.Messages))
	}
	if conversation.Messages[0].Role != "user" || conversation.Messages[0].Text != "@写手 你好" {
		t.Errorf("first message = %+v, want a person's message", conversation.Messages[0])
	}
	reply := conversation.Messages[1]
	if reply.Role != "agent" || reply.BotID != "scribbler" || reply.Text != "在的" {
		t.Errorf("reply = %+v, want the scribbler's answer", reply)
	}
	if len(conversation.Bots) != 2 || conversation.Bots[1].Persona != "负责文案" {
		t.Errorf("bots = %+v, want both cards with their persona", conversation.Bots)
	}
	if conversation.DefaultBotID != "lead" {
		t.Errorf("default bot = %q, want lead", conversation.DefaultBotID)
	}
}

func TestTimelineRejectsAWrongToken(t *testing.T) {
	server := serve(t, timelineJSON)
	client := New(server.URL, "wrong", "")

	if _, err := client.Timeline(context.Background()); err == nil {
		t.Fatal("Timeline accepted a request the surface refused")
	}
}

// A field the client does not know must survive a read and a write back out, so a newer backend can add one without
// this build dropping it.
func TestUnknownMessageFieldsSurvive(t *testing.T) {
	server := serve(t, timelineJSON)
	conversation, err := New(server.URL, "secret", "").Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline returned an error: %v", err)
	}
	raw, err := json.Marshal(conversation.Messages[2])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := back["future_field"]; !ok {
		t.Errorf("message lost the field it did not know: %s", raw)
	}
}

// A retry has to arrive as the same send, or the conversation shows the message twice.
func TestRetryReusesTheRequestID(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RequestID string `json:"request_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		seen = append(seen, body.RequestID)
		if len(seen) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"ok": true}`))
	}))
	t.Cleanup(server.Close)

	client := New(server.URL, "secret", "")
	requestID, err := client.Send(context.Background(), "在吗", nil)
	if err == nil {
		t.Fatal("Send reported success on a 502")
	}
	if requestID == "" {
		t.Fatal("Send returned no request id, so a retry has nothing to reuse")
	}
	if err := client.SendAgain(context.Background(), requestID, "在吗", nil); err != nil {
		t.Fatalf("SendAgain: %v", err)
	}
	if len(seen) != 2 || seen[0] != seen[1] {
		t.Fatalf("request ids = %v, want the same value twice", seen)
	}
}

// The backend panel shows tickets. They come from the same timeline call the conversation uses.
func TestTimelineCarriesTheBackendPanel(t *testing.T) {
	body := `{
      "items": [],
      "bots": [],
      "default_bot_id": "lead",
      "tasks": [
        {"id": "tk1", "title": "调开间距", "state": "work", "bot_id": "lin", "needs_person": ""},
        {"id": "tk2", "title": "确认合同", "state": "person", "bot_id": "zhou", "needs_person": "等你确认付款条款"},
        {"id": "tk3", "title": "跑测试", "state": "failed", "bot_id": "lin"}
      ],
      "status": {"runtime": "ready", "mobile": "on", "paused": false}
    }`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
	t.Cleanup(server.Close)

	conversation, err := New(server.URL, "secret", "").Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	if len(conversation.Tasks) != 3 {
		t.Fatalf("got %d tasks, want 3", len(conversation.Tasks))
	}
	if conversation.Tasks[1].NeedsPerson == "" {
		t.Error("a ticket waiting on a person must say what it is waiting for")
	}
	if conversation.Tasks[2].State != "failed" {
		t.Errorf("failed ticket reads as %q", conversation.Tasks[2].State)
	}
	if !conversation.Status.Ready() {
		t.Error("status should read ready")
	}
}

func TestStatusTellsReadyFromPaused(t *testing.T) {
	ready := BackendStatus{Runtime: "ready"}
	if !ready.Ready() {
		t.Error("runtime ready should read ready")
	}
	if (BackendStatus{Runtime: "ready", Paused: true}).Ready() {
		t.Error("a paused crew is not ready")
	}
	if (BackendStatus{Runtime: "starting"}).Ready() {
		t.Error("a starting crew is not ready")
	}
}

func TestTimelineCarriesQueuedRequests(t *testing.T) {
	body := `{"items": [], "bots": [], "default_bot_id": "lead", "tasks": [], "queued": ["req-2"],
	  "status": {"runtime": "ready"}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
	t.Cleanup(server.Close)
	conversation, err := New(server.URL, "secret", "").Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	if len(conversation.Queued) != 1 || conversation.Queued[0] != "req-2" {
		t.Errorf("queued = %v, want [req-2]", conversation.Queued)
	}
}

func TestAgentsWalksTheWholeTree(t *testing.T) {
	body := `{"ticket_id":"tk1","agents":[{"id":"worker-tk1","label":"工单","state":"working","children":[
	  {"id":"sub-a","label":"子代理","state":"done","children":[
	    {"id":"sub-a-1","label":"子代理","state":"done","children":[]}]},
	  {"id":"sub-b","label":"子代理","state":"working","children":[]}]}]}`
	var asked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.String()
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)

	tree, err := New(server.URL, "secret", "").Agents(context.Background(), "tk1")
	if err != nil {
		t.Fatalf("Agents: %v", err)
	}
	// Three levels deep must survive the decode, not flatten to two.
	if len(tree) != 1 || len(tree[0].Children) != 2 {
		t.Fatalf("tree = %+v", tree)
	}
	if tree[0].Children[0].Children[0].ID != "sub-a-1" {
		t.Errorf("grandchild lost: %+v", tree[0].Children[0])
	}
	if asked != "/api/mobile/agents?ticket=tk1" {
		t.Errorf("asked %q", asked)
	}
}

// 配对的入口在电脑这一侧：主人点一下拿码，念给自己听，手机拿码去提交。
func TestPairingCodeIsIssuedFromTheMachine(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if r.Method != http.MethodPost {
			t.Errorf("pairing must be a POST, got %s", r.Method)
		}
		_, _ = w.Write([]byte(`{"code":"123456","deviceId":"phone-1"}`))
	}))
	t.Cleanup(server.Close)

	code, err := New(server.URL, "secret", "").PairingCode(context.Background(), "phone-1")
	if err != nil {
		t.Fatalf("PairingCode: %v", err)
	}
	if code != "123456" {
		t.Errorf("code = %q", code)
	}
	// 管理面在 /orchestrator/api 下，不能直接打 /remote/pairing。
	if path != "/orchestrator/api/remote/pairing" {
		t.Errorf("asked %q", path)
	}
}

func TestDevicesListAndRevoke(t *testing.T) {
	var deleted string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"devices":[{"deviceId":"phone-1","name":"Kenton 的手机","platform":"android","pairedAt":"2026-11-09T00:00:00Z"}]}`))
		case http.MethodDelete:
			body, _ := io.ReadAll(r.Body)
			deleted = string(body)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	t.Cleanup(server.Close)
	client := New(server.URL, "secret", "")

	// 凭据摘要不能出现在列表里，那是可以拿来撞库的东西。
	raw, err := client.Devices(context.Background())
	if err != nil {
		t.Fatalf("Devices: %v", err)
	}
	if len(raw) != 1 || raw[0].Name != "Kenton 的手机" {
		t.Fatalf("devices = %+v", raw)
	}

	if err := client.Revoke(context.Background(), "phone-1"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if !strings.Contains(deleted, `"deviceId":"phone-1"`) {
		t.Errorf("revoke body = %s", deleted)
	}
}

func TestWorkReportsHowATicketWasDone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/mobile/work" || r.URL.Query().Get("ticket") != "tk1" {
			t.Errorf("asked %s", r.URL.String())
		}
		_, _ = w.Write([]byte(`{"ticket_id":"tk1","title":"调开间距","stage":"done","steps":[
		  {"at":"2026-11-09T10:00:00.000Z","kind":"did","text":"改了 login.tsx 两处"}]}`))
	}))
	t.Cleanup(server.Close)

	steps, err := New(server.URL, "secret", "").Work(context.Background(), "tk1")
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	if len(steps) != 1 || steps[0].Text != "改了 login.tsx 两处" {
		t.Errorf("steps = %+v", steps)
	}
}

func TestRetryAsksThePhoneSurface(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"retried":true}`))
	}))
	t.Cleanup(server.Close)

	if err := New(server.URL, "secret", "").Retry(context.Background(), "tk9"); err != nil {
		t.Fatalf("Retry: %v", err)
	}
	// 手机面到不了管理面（要求本机同源），重试也必须走 /api/mobile/retry。
	if path != "/api/mobile/retry" {
		t.Errorf("asked %q", path)
	}
}

// 独立监听那道门要的是「设备号 + 凭据」两样，不是 X-Crew-Token。
// 桌面端一开始只带了 token，结果是连不上 —— 这个测试盯住那份契约。
func TestSendsTheDeviceCredentialTheListenerChecks(t *testing.T) {
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[]}`))
	}))
	t.Cleanup(server.Close)

	if _, err := New(server.URL, "the-credential", "phone-1").Timeline(context.Background()); err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	if got.Get("x-crew-device") != "phone-1" {
		t.Errorf("device header = %q", got.Get("x-crew-device"))
	}
	if got.Get("x-crew-credential") != "the-credential" {
		t.Errorf("credential header = %q", got.Get("x-crew-credential"))
	}
}

// 没给设备号时也要发凭据：后端的 presented() 要「设备号 + 凭据」两样同时非空，
// 缺设备号直接 401。以前这里发的是空串设备号加空凭据，中栏那条棕色横幅就是这么来的。
//
// 这里把后端 lan-server.ts 的 presented() 与 devices.allows() 按同一套判定复刻一遍：
// 两个头都非空且都等于期望值才 200，否则 401 —— 断言就落在这条真契约上。
func TestFillsADeviceWhenOnlyTheTokenIsKnown(t *testing.T) {
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		presented := func(name string) (string, bool) {
			value := strings.TrimSpace(r.Header.Get(name))
			return value, value != ""
		}
		deviceID, hasDevice := presented("x-crew-device")
		credential, hasCredential := presented("x-crew-credential")
		if !hasDevice || !hasCredential || deviceID != defaultDeviceID || credential != "the-credential" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Not paired"}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[]}`))
	}))
	t.Cleanup(server.Close)

	if _, err := New(server.URL, "the-credential", "").Timeline(context.Background()); err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	if got.Get("x-crew-device") != defaultDeviceID {
		t.Errorf("device header = %q, want the default %q", got.Get("x-crew-device"), defaultDeviceID)
	}
	if got.Get("x-crew-credential") != "the-credential" {
		t.Errorf("credential header = %q, want the token", got.Get("x-crew-credential"))
	}
	// 证据：这是真发出去的那组头（X-Crew-Token / X-GW-Token 是兼容头，也一起带）。
	t.Logf("request headers = device:%q credential:%q X-Crew-Token:%q X-GW-Token:%q",
		got.Get("x-crew-device"), got.Get("x-crew-credential"), got.Get("X-Crew-Token"), got.Get("X-GW-Token"))
}

// 没 token 就一个凭据头都不发：空串凭据只会让对端分不清「没配」和「配错了」。
func TestSendsNoCredentialWhenThereIsNoToken(t *testing.T) {
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = w.Write([]byte(`{"items":[],"bots":[],"tasks":[]}`))
	}))
	t.Cleanup(server.Close)

	if _, err := New(server.URL, "", "").Timeline(context.Background()); err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	for _, name := range []string{"x-crew-credential", "x-crew-device", "X-Crew-Token", "X-GW-Token"} {
		if value := got.Get(name); value != "" {
			t.Errorf("%s should be absent without a token, got %q", name, value)
		}
	}
	t.Logf("request headers without a token = device:%q credential:%q",
		got.Get("x-crew-device"), got.Get("x-crew-credential"))
}

// 真实数据里有一条正文就是 URL 编码串，桌面端和手机都得把它解回人话。
func TestDecodesAUrlEncodedMessage(t *testing.T) {
	if got := readable("App%e5%8F%91%e7%9A%84%e4%B8%80%e5%8F%A5"); got != "App发的一句" {
		t.Errorf("readable = %q", got)
	}
}

func TestLeavesOrdinaryTextAlone(t *testing.T) {
	for _, raw := range []string{
		"完成了 50% 的进度",
		"@写手 用一句话介绍你自己",
		"100%zz", // 坏掉的序列不能被吞掉
	} {
		if got := readable(raw); got != raw {
			t.Errorf("readable(%q) = %q, should be unchanged", raw, got)
		}
	}
}

// 屏幕接口：带票号去问，reason 和活动快照都要读出来。
func TestScreenAsksForTheTicketAndReadsWhatCameBack(t *testing.T) {
	var path, query string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, query = r.URL.Path, r.URL.RawQuery
		_, _ = w.Write([]byte(`{"state":"live","kind":"terminal","ticket_id":"tk 9","live":true,
			"cwd":"/tmp/work","lines":[{"at":"2026-11-10T10:00:00Z","kind":"command","text":"$ pnpm test"}]}`))
	}))
	t.Cleanup(server.Close)

	view, err := New(server.URL, "secret", "").Screen(context.Background(), "tk 9")
	if err != nil {
		t.Fatalf("Screen: %v", err)
	}
	if path != "/api/mobile/screen" || query != "ticket=tk+9" {
		t.Errorf("asked %q?%s", path, query)
	}
	if view.State != "live" || view.Cwd != "/tmp/work" || len(view.Lines) != 1 {
		t.Fatalf("view = %+v", view)
	}
	if line := view.Lines[0]; line.Kind != "command" || line.Text != "$ pnpm test" {
		t.Errorf("line = %+v", line)
	}
}

// 推理档位：带 provider/model 去问，把适配器给出的档位原样读回来。
func TestEffortsReadsWhatTheRouteSupports(t *testing.T) {
	var path, query string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, query = r.URL.Path, r.URL.RawQuery
		_, _ = w.Write([]byte(`{"efforts":[{"id":"low","name":"Low"},{"id":"high","name":"High","description":"slower"}],"default":"low"}`))
	}))
	t.Cleanup(server.Close)

	view, err := New(server.URL, "secret", "").Efforts(context.Background(), "magpie", "kimi/k3")
	if err != nil {
		t.Fatalf("Efforts: %v", err)
	}
	if path != "/api/mobile/efforts" || query != "provider=magpie&model=kimi%2Fk3" {
		t.Errorf("asked %q?%s", path, query)
	}
	if len(view.Efforts) != 2 || view.Efforts[1].Description != "slower" || view.Default != "low" {
		t.Errorf("view = %+v", view)
	}
}

// 指定成员时把 bot_id 一起交给后端：只换那一位，不动全场默认。
func TestSwitchingOneMembersModelSendsItsBotID(t *testing.T) {
	var sent map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	if err := New(server.URL, "secret", "").SwitchModel(context.Background(),
		ModelChoice{Provider: "magpie", Model: "kimi/k3", ReasoningEffort: "high"}, "scribbler"); err != nil {
		t.Fatalf("SwitchModel: %v", err)
	}
	if sent["bot_id"] != "scribbler" || sent["reasoningEffort"] != "high" || sent["provider"] != "magpie" {
		t.Errorf("sent = %v", sent)
	}
}

// 管理面与消息面是两个端口：设备表、备份只在管理面上。
// 拿消息面端口去要它们只会 404 —— 桌面端发现队伍时必须把管理面地址接上。
func TestManagementRequestsGoToTheManagementPort(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.Header.Get("x-orchestrator-request") != "1" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"devices":[]}`))
	}))
	defer server.Close()
	c := New("http://127.0.0.1:1", "t", "d").WithManagement(server.URL)
	if _, err := c.Devices(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/orchestrator/api/remote/devices" {
		t.Errorf("请求打到了 %q，应该走管理面", gotPath)
	}
}

// 「上限 3 并发」那个数必须从管理面读回来，不能在界面里写死。
// 它在后端是 executor.maxWorkers（policy.ts 默认 3，管理面板里可改），
// 所以这里钉住路径与字段名。
func TestCrewLoadComesFromTheManagementSurface(t *testing.T) {
	var path, sameOrigin string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		sameOrigin = r.Header.Get("x-orchestrator-request")
		_, _ = w.Write([]byte(`{"load":{"running":1,"queued":0,"maxWorkers":3}}`))
	}))
	defer server.Close()

	c := New("http://127.0.0.1:1", "t", "d").WithManagement(server.URL)
	load, err := c.CrewLoad(context.Background())
	if err != nil {
		t.Fatalf("读槽位情况失败: %v", err)
	}
	if path != "/orchestrator/api/state" {
		t.Errorf("打到 %q，应该是管理面的 /state", path)
	}
	if sameOrigin != "1" {
		t.Errorf("没带同源标记，管理面会拒：%q", sameOrigin)
	}
	if load.MaxWorkers != 3 || load.Running != 1 || load.Queued != 0 {
		t.Errorf("槽位情况解析错: %+v", load)
	}
}

// 后端没报并发上限（0）时整份丢掉：界面上不画「上限 0 并发」这种假话。
func TestCrewLoadWithoutALimitIsDiscarded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"load":{"running":0,"queued":0}}`))
	}))
	defer server.Close()

	c := New("http://127.0.0.1:1", "t", "d").WithManagement(server.URL)
	load, err := c.CrewLoad(context.Background())
	if err == nil {
		t.Fatalf("没有上限时应该报错让界面别画，实际拿到了 %+v", load)
	}
	// 读不到的那几种原因要分得开：这一种不是「连不上」，是「这个后端没报」。
	// 断连时 management() 会返回 URL 之类的原话，界面上说的是另一句。
	if load != nil {
		t.Error("报错时不该同时给出一份数据")
	}
}

// #8-2：看门狗告警从管理面 /state 的 watchdog 读回来，解析要对；没有该字段时返回 nil（不画横幅）。
func TestCrewWatchdogParsesAlertsFromState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"watchdog":{"alerts":[{"at":"2026-11-13T00:00:00Z","kind":"eval_timeout","title":"有一件事没判下来","body":"「修一下」评估超时，队伍没有接。","decisionId":"d-1"}],"lastSelfHealAt":"2026-11-13T00:01:00Z"}}`))
	}))
	defer server.Close()
	c := New("http://127.0.0.1:1", "t", "d").WithManagement(server.URL)
	wd, err := c.CrewWatchdog(context.Background())
	if err != nil {
		t.Fatalf("读看门狗失败: %v", err)
	}
	if wd == nil || len(wd.Alerts) != 1 {
		t.Fatalf("应解析出 1 条告警，实际 %+v", wd)
	}
	if wd.Alerts[0].DecisionID != "d-1" || wd.Alerts[0].Kind != "eval_timeout" {
		t.Errorf("告警字段解析错: %+v", wd.Alerts[0])
	}
	if wd.LastSelfHealAt != "2026-11-13T00:01:00Z" {
		t.Errorf("上次自愈时刻解析错: %q", wd.LastSelfHealAt)
	}
}

// 老后端没有 watchdog 字段：返回 nil，界面据此不画横幅（「读不到」不当成「没告警」去画空条）。
func TestCrewWatchdogMissingFieldIsNil(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"load":{"running":0,"queued":0,"maxWorkers":3}}`))
	}))
	defer server.Close()
	c := New("http://127.0.0.1:1", "t", "d").WithManagement(server.URL)
	wd, err := c.CrewWatchdog(context.Background())
	if err != nil {
		t.Fatalf("读看门狗失败: %v", err)
	}
	if wd != nil {
		t.Errorf("没有 watchdog 字段时应返回 nil，实际 %+v", wd)
	}
}
