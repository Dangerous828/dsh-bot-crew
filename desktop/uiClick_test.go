package main

import (
	"image"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 这一组盯的是「看着能点的地方，指针真的变手」。
//
// 之前右栏三个页签（进行中 / 待你 / 已完成）只有 OnClick、没有 Cursor：按下去有效，
// 悬停时指针却不变，看上去像三个不能点的字。用户在画板上就是被这一处惹到。
// 光读代码看不出来 —— 引擎只认自己元素上的 cursor 字段，得把指针移上去读回来。

// pixel 读出图上那一个点的颜色，用来核对底色到底画成什么。
func pixel(img *image.RGBA, off int) ui.Color {
	return ui.RGBA(img.Pix[off], img.Pix[off+1], img.Pix[off+2], float32(img.Pix[off+3])/255)
}

// hoverCursor 把指针移到那个字上，返回引擎最后画的指针形状。
func hoverCursor(tt *ui.Tester, text string) (ui.Cursor, bool) {
	r, ok := tt.Find(text)
	if !ok {
		return ui.CursorDefault, false
	}
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	return tt.Cursor(), true
}

// workPaneIn 把右栏单独放进一扇窗里画，量到的就是右栏这一块。
func workPaneIn(s *app, p Palette) *ui.Tester {
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Width(393).FillHeight().PaddingX(16).PaddingY(22).Background(p.Surface).Children(func() {
			s.workPane(c, p)
		})
	}, 393, 500)
	tt.Frame()
	return tt
}

// 右栏底部的「队列 / N 等待 · 上限 M 并发」只在真的读到槽位情况时才画。
//
// 这条盯的是诚实：上限来自管理面的 maxWorkers，读不到时那一行整行不出现，
// 而不是留一个写死的「上限 3 并发」撑场面。
func TestTheQueueRowOnlyAppearsWithRealNumbers(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{}
	p := PaletteFor(false)

	// 还没读到：不画。
	tt := workPaneIn(s, p)
	tt.Frame()
	if tt.HasText("上限 3 并发") || tt.HasText("0 等待 · 上限 3 并发") {
		t.Error("没读到槽位情况却画出了并发上限：那个数是编的")
	}

	// 读到了：照管理面报的数画。
	s.crewLoad = &CrewLoad{Running: 1, Queued: 0, MaxWorkers: 3}
	tt = workPaneIn(s, p)
	tt.Frame()
	if !tt.HasText("0 等待 · 上限 3 并发") {
		t.Errorf("读到了槽位情况却没画那一行；画的是 %v", tt.Texts())
	}

	// 上限不是 3 时画的是后端那个数，不是写死的 3。
	s.crewLoad = &CrewLoad{Running: 2, Queued: 2, MaxWorkers: 5}
	tt = workPaneIn(s, p)
	tt.Frame()
	if !tt.HasText("2 等待 · 上限 5 并发") {
		t.Errorf("上限跟着管理面走才算读回来的；画的是 %v", tt.Texts())
	}
}

// 三个页签悬停都要变手。
func TestTheThreeTabsShowThePointer(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	tt := workPaneIn(s, PaletteFor(false))
	for _, label := range []string{"进行中", "待你", "已完成"} {
		cursor, found := hoverCursor(tt, label)
		if !found {
			t.Fatalf("找不到页签「%s」：右栏没画出来", label)
		}
		if cursor != ui.CursorPointer {
			t.Errorf("指针停在「%s」上时是 %v，应该是手型：这一格点得动", label, cursor)
		}
	}
}

// 分段控件按画板画：整条轨道 Track，选中的那个白胶囊，没选中的透明。
func TestTheTabBarIsASegmentedControl(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	p := PaletteFor(false)
	tt := workPaneIn(s, p)
	img := tt.Image()
	rgb := func(x, y float32) ui.Color {
		o := img.PixOffset(int(x), int(y))
		return pixel(img, o)
	}
	// 取样点在字的上方一行：胶囊高 26、字只有 13，上面那一条一定是纯底色，不会碰上字的抗锯齿。
	top := func(label string) ui.Color {
		r, ok := tt.Find(label)
		if !ok {
			t.Fatalf("找不到页签「%s」", label)
		}
		return rgb(r.X+r.W/2, r.Y-4)
	}
	if got := top("进行中"); got != p.Card {
		t.Errorf("选中的页签底色是 %v，画板是白胶囊 %v", got, p.Card)
	}
	// 未选中的两格：颜色等于轨道本身，也就是透明。
	if got, want := top("已完成"), p.Track; got != want && got != p.Surface {
		t.Errorf("没选中的页签不该有自己的底：现在是 %v（轨道 %v）", got, want)
	}
}

// 按下去要有回音：按下时底色变，松手回到选中态。
func TestPressingATabShowsIt(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	p := PaletteFor(false)
	tt := workPaneIn(s, p)
	r, ok := tt.Find("待你")
	if !ok {
		t.Fatal("找不到页签「待你」")
	}
	cx, cy := r.X+r.W/2, r.Y+r.H/2
	sample := func() ui.Color {
		img := tt.Image()
		return pixel(img, img.PixOffset(int(cx), int(r.Y-4)))
	}
	idle := sample()
	tt.Press(cx, cy)
	tt.Frame()
	pressed := sample()
	if pressed == idle {
		t.Errorf("按住「待你」时底色没变（都是 %v）：按下去没有反馈", idle)
	}
	if pressed != p.PressedSoft {
		t.Errorf("按住没选中的页签应该是 %v，现在是 %v", p.PressedSoft, pressed)
	}
	tt.Release(cx, cy)
	tt.Frame()
	if s.backendTab != 1 {
		t.Fatalf("点完「待你」应该切到第 1 栏，现在是 %d", s.backendTab)
	}
	if got := sample(); got != p.Card {
		t.Errorf("松手后它成了选中的那个，应该是白胶囊 %v，现在是 %v", p.Card, got)
	}
}

// 断连和真空是两件事：读不到就说读不到，别说「这一栏还是空的」。
func TestTheEmptyPaneTellsDisconnectFromEmpty(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	tt := workPaneIn(s, PaletteFor(false))
	if !tt.HasText("进行中没有工单。") {
		t.Errorf("连上了但没有工单，应该写「进行中没有工单。」；现在画的是 %v", tt.Texts())
	}
	if !tt.HasText("0 张") {
		t.Errorf("空栏也要有张数：现在画的是 %v", tt.Texts())
	}

	s.problem = "dial tcp: connection refused"
	tt = workPaneIn(s, PaletteFor(false))
	tt.Frame()
	if tt.HasText("进行中没有工单。") {
		t.Error("断连时也写「进行中没有工单」，等于说「没有工单」，可数据没读到")
	}
	if !tt.HasText("还没连上，读不到工单") {
		t.Errorf("断连时应该说读不到工单；现在画的是 %v", tt.Texts())
	}
}

// 标题栏那两个按钮（看它的屏幕 / ···）悬停也要变手。
func TestTheHeaderButtonsShowThePointer(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{}
	p := PaletteFor(false)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Width(718).FillHeight().Background(p.Surface).Children(func() {
			s.conversationPane(c, p)
		})
	}, 718, 600)
	tt.Frame()
	for _, label := range []string{"▭ 看它的屏幕", "···"} {
		cursor, found := hoverCursor(tt, label)
		if !found {
			t.Fatalf("找不到标题栏按钮「%s」", label)
		}
		if cursor != ui.CursorPointer {
			t.Errorf("指针停在「%s」上时是 %v，应该是手型", label, cursor)
		}
	}
}

// 工单卡、模型行、左栏导航——凡是接了点击的，指针都得变手。
//
// 这几处本来就有 Cursor，留着这组是防止将来改卡片样式时把它删掉：
// 少了它不会报错，只会让指针在这一块悄悄变回箭头。
func TestEveryClickableShowsThePointer(t *testing.T) {
	withTask := func() *app {
		s := newApp(New("http://127.0.0.1:1", "t", ""))
		s.conversation = &Conversation{
			Tasks: []Task{{ID: "t1", Title: "改样式", State: "failed", Open: true, BotID: "b1"}},
			Bots:  []BotCard{{ID: "b1", Name: "林", Persona: "前端"}},
		}
		return s
	}

	t.Run("工单卡", func(t *testing.T) {
		s := withTask()
		p := PaletteFor(false)
		tt := ui.NewTester(func(c *ui.Context) {
			ui.Column(c).Width(393).FillHeight().PaddingX(16).PaddingY(22).Background(p.Surface).Children(func() {
				s.workPane(c, p)
			})
		}, 393, 700)
		tt.Frame()
		if !tt.HasText("改样式") {
			t.Fatalf("工单卡没画出来；画的是 %v", tt.Texts())
		}
		// 卡上的字在这里量不出宽高（Tester 给的位置不带尺寸），所以按卡自己的横向量落点：
		// 这一扇窗只画右栏这一栏（393 宽、内边距 16），工单卡从标题下面开始铺。
		found := false
		for y := float32(60); y < 690 && !found; y += 5 {
			tt.Move(70, y)
			tt.Frame()
			found = tt.Cursor() == ui.CursorPointer
		}
		if !found {
			t.Fatal("整栏扫下来，没有一个像素的指针是手型：工单卡没接上点击")
		}
		tt.Frame()
		if got := tt.Cursor(); got != ui.CursorPointer {
			t.Errorf("指针停在工单卡上是 %v，应该是手型：整张卡都能点", got)
		}
	})

	t.Run("左栏导航项", func(t *testing.T) {
		s := withTask()
		p := PaletteFor(false)
		tt := ui.NewTester(func(c *ui.Context) {
			ui.Row(c).Width(SidebarWidth).FillHeight().Background(p.Card).Children(func() {
				s.navRow(c, p, navBackend)
			})
		}, SidebarWidth, 200)
		tt.Frame()
		_, word := navLabel(navBackend)
		cursor, found := hoverCursor(tt, word)
		if !found {
			t.Fatalf("找不到导航项「%s」", word)
		}
		if cursor != ui.CursorPointer {
			t.Errorf("指针停在导航项上是 %v，应该是手型", cursor)
		}
	})

	t.Run("模型行", func(t *testing.T) {
		s := withTask()
		s.models = &ModelCatalog{Providers: []ModelProvider{
			{ID: "dsh", Name: "DSH", Models: []ModelOption{{ID: "m1", Name: "一号"}}},
		}}
		p := PaletteFor(false)
		tt := ui.NewTester(func(c *ui.Context) {
			ui.Row(c).Width(393).FillHeight().Background(p.Surface).Children(func() {
				s.modelRow(c, p, "dsh", ModelOption{ID: "m1", Name: "一号"})
			})
		}, 393, 120)
		tt.Frame()
		cursor, found := hoverCursor(tt, "一号")
		if !found {
			t.Fatalf("找不到模型行「一号」；画的是 %v", tt.Texts())
		}
		if cursor != ui.CursorPointer {
			t.Errorf("指针停在模型行上是 %v，应该是手型", cursor)
		}
	})
}

// 左栏点一位：选中他，并且回到对话主界面（右栏收起）。
func TestClickingABotReturnsToTheConversation(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{
		Bots:         []BotCard{{ID: "lead", Name: "大哥"}, {ID: "scribe", Name: "写手"}},
		DefaultBotID: "lead",
	}
	s.backendOpen = true
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1100, 700)
	tt.Frame()
	if err := tt.Click("写手"); err != nil {
		t.Fatalf("点左栏的「写手」失败：%v", err)
	}
	tt.Frame()
	if s.selectedBot != "scribe" {
		t.Errorf("选中的人是 %q，应该是 scribe", s.selectedBot)
	}
	if s.backendOpen {
		t.Error("点左栏之后右栏还开着：这样回不到对话主界面")
	}
}

// 右栏收起后要留一条能点开的窄边，不能只能靠再按一次「后台」。
func TestCollapsedBackendHasAWayBack(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	s.backendOpen = false
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1100, 700)
	tt.Frame()
	if err := tt.Click("‹"); err != nil {
		t.Fatalf("收起后找不到能点开的窄边：%v", err)
	}
	tt.Frame()
	if !s.backendOpen {
		t.Error("点了窄边，右栏没有展开")
	}
}

// 「看它的屏幕」的实话显示在标题下面，不能冒充连接故障把发送锁住。
func TestTheScreenNoteIsNotAConnectionBanner(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{}
	s.screenNote = "后端还没有画面源，worker 不跑浏览器"
	p := PaletteFor(false)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Width(718).FillHeight().Background(p.Surface).Children(func() { s.conversationPane(c, p) })
	}, 718, 600)
	tt.Frame()
	if !tt.HasText("后端还没有画面源，worker 不跑浏览器") {
		t.Errorf("屏幕的说明没画出来；画的是 %v", tt.Texts())
	}
	if tt.HasText("连不上") {
		t.Error("屏幕功能缺失被写成了连接故障")
	}
	if s.problem != "" {
		t.Error("屏幕说明不该写进全局 problem")
	}
}

// 左栏也能收起，收起后留一条能点开的窄边。
func TestTheSidebarCanCollapseAndReopen(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1100, 700)
	tt.Frame()
	if err := tt.Click("«"); err != nil {
		t.Fatalf("找不到左栏收起按钮：%v", err)
	}
	tt.Frame()
	if !s.sidebarClosed {
		t.Fatal("点了「«」，左栏没有收起")
	}
	if err := tt.Click("»"); err != nil {
		t.Fatalf("收起后找不到能点开的窄边：%v", err)
	}
	tt.Frame()
	if s.sidebarClosed {
		t.Error("点了窄边，左栏没有展开")
	}
}

// 「看它的屏幕」读回来后，中间栏显示的是它跑过的命令；点返回回到对话。
func TestTheScreenPaneShowsWhatTheWorkerDid(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.screen = &ScreenView{State: "live", Cwd: "/tmp/work", Lines: []ScreenLine{
		{At: "2026-11-10T10:00:00Z", Kind: "command", Text: "$ pnpm test"},
		{At: "2026-11-10T10:00:05Z", Kind: "output", Text: "1429 passed"},
	}}
	p := PaletteFor(false)
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Width(720).FillHeight().Background(p.Surface).Children(func() { s.conversationPane(c, p) })
	}, 720, 700)
	tt.Frame()

	shown := strings.Join(tt.Texts(), "\n")
	if !strings.Contains(shown, "$ pnpm test") {
		t.Fatalf("屏幕画出来了，却没有显示它跑过的命令：%q", tt.Texts())
	}
	if !strings.Contains(shown, "1429 passed") {
		t.Fatalf("输出那一行也没了：%q", tt.Texts())
	}
	if _, found := tt.Find("返回对话"); !found {
		t.Fatal("找不到返回对话")
	}
	tt.Click("返回对话")
	tt.Frame()
	if s.screen != nil {
		t.Error("点了返回，画面还挂着")
	}
}

// 左栏标题栏的「+」是加一位 Bot 的入口：有 Bot 时也能点，切到模型页。
func TestThePlusInTheTitleOpensTheModelPage(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1100, 700)
	tt.Frame()
	if err := tt.Click("+"); err != nil {
		t.Fatalf("找不到标题栏的「+」：%v", err)
	}
	tt.Frame()
	if s.navTab != navModel {
		t.Errorf("点了「+」之后在第 %v 页，应该切到模型页（加一位 Bot）", s.navTab)
	}
}

// 全屏看屏幕：左右两栏收掉，画面占满窗户；退出后两栏回来。
func TestTheScreenCanTakeTheWholeWindow(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	s.screen = &ScreenView{State: "live", Cwd: "/tmp/work", Lines: []ScreenLine{
		{At: "2026-11-10T10:00:00Z", Kind: "command", Text: "$ pnpm test"},
	}}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1100, 700)
	tt.Frame()
	if !tt.HasText("我的队伍") {
		t.Fatalf("还没全屏时左栏应该在；画的是 %v", tt.Texts())
	}
	if err := tt.Click("全屏"); err != nil {
		t.Fatalf("找不到「全屏」：%v", err)
	}
	tt.Frame()
	if !s.screenFull {
		t.Fatal("点了「全屏」，状态没变")
	}
	if tt.HasText("我的队伍") {
		t.Error("全屏后左栏还画着：窗口没有让给屏幕")
	}
	if !tt.HasText("它在做什么") {
		t.Errorf("全屏后看不到屏幕面板；画的是 %v", tt.Texts())
	}
	if err := tt.Click("退出全屏"); err != nil {
		t.Fatalf("找不到「退出全屏」：%v", err)
	}
	tt.Frame()
	if s.screenFull {
		t.Error("点了「退出全屏」，状态没回来")
	}
	if !tt.HasText("我的队伍") {
		t.Error("退出全屏后左栏没有回来")
	}
	// 返回对话要把全屏状态一起复位，下次打开不会直接占满窗口。
	tt.Click("全屏")
	tt.Frame()
	tt.Click("返回对话")
	tt.Frame()
	if s.screen != nil || s.screenFull {
		t.Errorf("返回对话后 screen=%v full=%v，应该都清掉", s.screen, s.screenFull)
	}
}

// 点花名册上的「改」打开编辑层：名字与人设都在，草稿来自当前名单。
func TestEditingABotShowsHisCurrentWords(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{
		Bots: []BotCard{{ID: "coder", Name: "码农", Persona: "写代码先看现有约定。"}}, DefaultBotID: "coder",
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1100, 700)
	tt.Frame()
	if err := tt.Click("改"); err != nil {
		t.Fatalf("花名册上没有「改」：%v", err)
	}
	tt.Frame()
	if s.editingBot != "coder" {
		t.Fatalf("点「改」之后编辑的是 %q，应该是 coder", s.editingBot)
	}
	if s.botName != "码农" || s.botPersona != "写代码先看现有约定。" {
		t.Errorf("草稿是 %q / %q，应该来自当前名单", s.botName, s.botPersona)
	}
	if !tt.HasText("改这一位") {
		t.Errorf("编辑层没画出来；画的是 %v", tt.Texts())
	}
	// 取消要真的关掉，并且不改任何东西。
	if err := tt.Click("取消"); err != nil {
		t.Fatalf("找不到取消：%v", err)
	}
	tt.Frame()
	if s.editingBot != "" {
		t.Error("点了取消，编辑层还开着")
	}
}

// 名字空了不许发：本地就挡住，不发一趟无意义的请求。
func TestAnEmptyNameIsRefusedBeforeSending(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "coder", Name: "码农"}}, DefaultBotID: "coder"}
	s.editBot(BotCard{ID: "coder", Name: "码农"})
	s.botName = "   "
	s.saveBot()
	if s.botError == "" {
		t.Error("空名字没有报错")
	}
	if s.botSaving {
		t.Error("空名字不该发出请求")
	}
}

// 已配对的设备要看得见：手机丢了才知道该撤哪一台。
// 之前客户端有 Devices/Revoke，界面上却从来没有这块 —— 等于没有。
func TestThePairedDevicesAreListedAndRevocable(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	s.backendOpen = true
	s.devicesTried = true
	s.devices = []PairedDevice{
		{DeviceID: "d1", Name: "Kenton 的手机", Platform: "android", PairedAt: "2026-11-10T12:00:00Z"},
		{DeviceID: "d2", Name: "旧手机", Platform: "ios", PairedAt: "2026-11-01T09:00:00Z"},
	}
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 714)
	tt.Frame()
	for _, name := range []string{"Kenton 的手机", "旧手机"} {
		if !tt.HasText(name) {
			t.Errorf("设备「%s」没出现在右栏；画的是 %v", name, tt.Texts())
		}
	}
	// 每台一个「撤掉」。
	count := 0
	for _, text := range tt.Texts() {
		if text == "撤掉" {
			count++
		}
	}
	if count < 2 {
		t.Errorf("两台设备应该有 %d 个「撤掉」，实际 %d 个", 2, count)
	}
}

// 读设备失败要说出来，不能安静地把整块藏掉 —— 那样人以为没有设备配过。
func TestAFailedDeviceListSaysSo(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	s.backendOpen = true
	s.devicesTried = true
	s.devicesNote = "读不到已配对的设备：management route refused"
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 714)
	tt.Frame()
	if !tt.HasText("读不到已配对的设备：management route refused") {
		t.Errorf("读设备失败没说出来；画的是 %v", tt.Texts())
	}
}

// 第一次打开时，空态要说清「怎么开始」，而不是只留一句「还没有人说话」。
func TestTheEmptyConversationTeachesTheFirstStep(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Width(718).FillHeight().Background(PaletteFor(false).Surface).Children(func() {
			s.conversationPane(c, PaletteFor(false))
		})
	}, 718, 700)
	tt.Frame()
	for _, step := range []string{"在下面说一句话，或者 @ 某一位", "右栏能看到进度", "它会记住你们的对话"} {
		if !tt.HasText(step) && !strings.Contains(strings.Join(tt.Texts(), "\n"), step) {
			t.Errorf("空态缺这一步引导：%q；画的是 %v", step, tt.Texts())
		}
	}
	// 有一句话之后就不该再教了：那是打扰。
	s.conversation.Messages = []Message{{ID: "m1", Text: "你好", At: "2026-11-11T00:00:00Z"}}
	tt.Frame()
	if strings.Contains(strings.Join(tt.Texts(), "\n"), "它会记住你们的对话") {
		t.Error("已经有消息了还在显示新手指引")
	}
}

// 备份要有入口：右栏给一个「导出备份」，成功后说清存到哪了。
func TestTheRecordsCanBeExportedFromTheBackendPane(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead"}
	s.backendOpen = true
	s.devicesTried = true
	s.exportNote = "已备份到 /Users/me/Desktop/crew-backup-20261111-110000.json"
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1280, 714)
	tt.Frame()
	if !tt.HasText("导出备份") {
		t.Errorf("右栏没有「导出备份」；画的是 %v", tt.Texts())
	}
	if !tt.HasText("已备份到 /Users/me/Desktop/crew-backup-20261111-110000.json") {
		t.Errorf("导出的结果没说清存到哪；画的是 %v", tt.Texts())
	}
}
