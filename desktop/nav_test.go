package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 左栏那四项，按下去都必须有看得见的反应。
//
// 用户点名的原话是「你现在这个是死的点什么都没反应」。这条测试盯的就是这件事：
// 每一项都返回「要重画」，而且要重画的东西真的变了。
//
// 起点故意从别处开始（先站在「产出」上），否则「后台」这一下按下去是开关的另一半 ——
// 那也算有反应，但测不出「从别处切过来」这条主路径。
func TestEveryNavItemDoesSomething(t *testing.T) {
	for _, item := range navOrder {
		_, name := navLabel(item)
		s := newApp(New("http://127.0.0.1:1", "t", ""))
		s.navTab = navOutput
		if !s.pressNav(item) {
			t.Fatalf("%s：按下去没有任何反应", name)
		}
		if s.navTab != item && item != navBackend {
			t.Fatalf("%s：按下去之后右栏还停在 %v", name, s.navTab)
		}
		if !s.backendOpen {
			t.Fatalf("%s：按下去之后右栏是收着的，等于什么都没看见", name)
		}
		// 第二下是开关的另一半：除了「后台」，别人再点还是打开着的。
		s.pressNav(item)
		if item != navBackend && !s.backendOpen {
			t.Fatalf("%s：再点一次把右栏关掉了，它不该是个开关", name)
		}
	}
}

// 「后台」再点一次是把右栏收起来，让对话占满；第三次点回来还是「进行中」。
func TestBackendNavTogglesAndComesBackHome(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	if !s.backendOpen || s.navTab != navBackend {
		t.Fatal("打开窗口时就该停在后台那一栏")
	}
	s.backendTab = 2 // 先切到「已完成」，验证收起再打开会回到「进行中」
	s.pressNav(navBackend)
	if s.backendOpen {
		t.Fatal("已经停在后台，再点一次应该把右栏收起来")
	}
	s.pressNav(navBackend)
	if !s.backendOpen || s.backendTab != 0 {
		t.Fatalf("重新打开应该回到「进行中」，现在 backendTab=%d open=%v", s.backendTab, s.backendOpen)
	}
}

// 点「模型」会去读目录 —— 没读过就显示「正在读」而不是「没有模型」。
func TestModelNavAsksForTheCatalog(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.pressNav(navModel)
	if s.models != nil {
		t.Fatal("还没读回来就当成有目录了")
	}
	if s.modelNote == "" {
		t.Fatal("点开模型栏得说一句「正在读」，否则看起来是空的")
	}
}

// 正在用的那一个要认得出；空的两个不认。
func TestChosenModelMatchesProviderAndModelTogether(t *testing.T) {
	current := &ModelChoice{Provider: "dsh", Model: "m1"}
	if !chosenModel(current, "dsh", "m1") {
		t.Fatal("同一个 provider 上同一个模型，应该认出来")
	}
	if chosenModel(current, "other", "m1") {
		t.Fatal("别的 provider 上同名模型不是同一个东西")
	}
	if chosenModel(nil, "dsh", "m1") {
		t.Fatal("还不知道现在用的是什么，就不该说谁被选中")
	}
	if chosenModel(current, "", "") {
		t.Fatal("两边都空，比出来的是假话")
	}
}

// 只能挑目录里真有的：挑一个不存在的不谎报成功。
func TestPickModelOnlyPicksWhatTheCatalogHas(t *testing.T) {
	catalog := &ModelCatalog{Providers: []ModelProvider{
		{ID: "dsh", Name: "DSH", Models: []ModelOption{{ID: "m1", Name: "Model One"}}},
	}}
	choice, ok := pickModel(catalog, "dsh", "m1")
	if !ok || choice != (ModelChoice{Provider: "dsh", Model: "m1"}) {
		t.Fatalf("目录里有这一个，应该挑得出来：%v %v", choice, ok)
	}
	if _, ok := pickModel(catalog, "dsh", "nope"); ok {
		t.Fatal("目录里没有的模型不该能选中")
	}
	if _, ok := pickModel(catalog, "nope", "m1"); ok {
		t.Fatal("没有这一家，就不该说有")
	}
	if _, ok := pickModel(nil, "dsh", "m1"); ok {
		t.Fatal("没读过目录，挑不出来")
	}
}

// 换成功之后，左栏和右栏都得跟着改，不用等人再点一次刷新。
func TestSwitchingAModelShowsUpEverywhere(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.models = &ModelCatalog{Providers: []ModelProvider{
		{ID: "dsh", Name: "DSH", Models: []ModelOption{{ID: "m1"}, {ID: "m2"}}},
	}, Current: &ModelChoice{Provider: "dsh", Model: "m1"}}
	s.conversation = &Conversation{Model: "m1"}
	s.modelNote = "正在换…"

	s.applyModel(modelSwitchResult{choice: ModelChoice{Provider: "dsh", Model: "m2"}})

	if s.models.Current.Model != "m2" {
		t.Fatalf("目录里现在用的是 %s", s.models.Current.Model)
	}
	if s.modelName() != "m2" {
		t.Fatalf("左栏还写着 %s", s.modelName())
	}
	if s.modelNote != "" {
		t.Fatalf("换完了还挂着 %q", s.modelNote)
	}
}

// 「产出」「常规任务」没有数据，那就说清楚，不能是一片空白。
func TestEmptyPanesSayWhyTheyAreEmpty(t *testing.T) {
	for _, item := range []navItem{navOutput, navRoutine} {
		title, body := emptyCopy(item)
		_, name := navLabel(item)
		if title == "" || body == "" {
			t.Fatalf("%s：空态得有一句话，现在是空的", name)
		}
		if name == "" {
			t.Fatalf("%v：连名字都没有", item)
		}
	}
	// 常规任务接上后端（契约 §5.5）之后，空态仍要把「到点不会自己跑」说出来：
	// 让人以为放着它就会跑，比空着更糟。
	if _, body := emptyCopy(navRoutine); !strings.Contains(body, "调度器") {
		t.Fatalf("常规任务的空态没说它不会自己跑：%q", body)
	}
}

// 模型面板：每位成员可以有自己的路由，推理档位按当前作用域那条路由显示。
func TestEachMemberCanUseItsOwnModelAndEffort(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.models = &ModelCatalog{
		Current:   &ModelChoice{Provider: "magpie", Model: "kimi/k3"},
		BotModels: map[string]ModelChoice{"scribbler": {Provider: "magpie", Model: "kimi/k3.1-pro", ReasoningEffort: "high"}},
		Providers: []ModelProvider{{ID: "magpie", Name: "Magpie", Models: []ModelOption{{ID: "kimi/k3"}, {ID: "kimi/k3.1-pro"}}}},
	}
	s.conversation = &Conversation{Bots: []BotCard{{ID: "scribbler", Name: "写手"}}}
	s.modelScope = "scribbler"
	s.efforts = &EffortsView{Efforts: []EffortOption{{ID: "low", Name: "Low"}, {ID: "high", Name: "High"}}, Default: "low"}

	if got := s.currentModel(); got != "kimi/k3.1-pro · magpie · high" {
		t.Fatalf("成员的作用域读到的是 %q", got)
	}
	if s.routeForScope().Model != "kimi/k3.1-pro" {
		t.Fatalf("成员路由 = %+v", s.routeForScope())
	}
	// 换回全员后读的是全场默认，而不是上一位成员的。
	s.modelScope = ""
	if got := s.currentModel(); got != "kimi/k3 · magpie" {
		t.Fatalf("全员的作用域读到的是 %q", got)
	}
}

// 「跟随全员」真的会把成员路由清掉，而不是只在界面上变一下。
func TestFallingBackToTheCrewDefaultClearsTheMembersRoute(t *testing.T) {
	posted := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mobile/models":
			_, _ = w.Write([]byte(`{"current":{"provider":"magpie","model":"base"},"bot_models":{"scribbler":{"provider":"magpie","model":"own"}},"providers":[]}`))
		case "/api/mobile/efforts":
			_, _ = w.Write([]byte(`{"efforts":[]}`))
		case "/api/mobile/model":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			posted <- body
			_, _ = w.Write([]byte(`{"ok":true,"bot_id":"scribbler"}`))
		default:
			_, _ = w.Write([]byte(`{"items":[],"tasks":[],"bots":[{"bot_id":"scribbler","name":"写手"}]}`))
		}
	}))
	t.Cleanup(server.Close)

	s := newApp(New(server.URL, "secret", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "scribbler", Name: "写手"}}}
	s.models = &ModelCatalog{Current: &ModelChoice{Provider: "magpie", Model: "base"},
		BotModels: map[string]ModelChoice{"scribbler": {Provider: "magpie", Model: "own"}}}
	s.modelScope = "scribbler"
	s.navTab = navModel
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 746)
	tt.Frame()
	if _, ok := tt.Find("跟随全员"); !ok {
		t.Fatalf("有成员路由时应该出现「跟随全员」；画的是 %v", tt.Texts())
	}
	tt.Click("跟随全员")
	select {
	case body := <-posted:
		if body["bot_id"] != "scribbler" || body["model"] != "" {
			t.Fatalf("提交的是 %v", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("点了「跟随全员」却没有提交")
	}
}
