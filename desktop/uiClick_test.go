package main

import (
	"image"
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
		ui.Row(c).Width(393).FillHeight().PaddingX(16).PaddingY(22).Background(p.Surface).Children(func() {
			s.workPane(c, p)
		})
	}, 393, 500)
	tt.Frame()
	return tt
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
	if !tt.HasText("这一栏还是空的。") {
		t.Errorf("连上了但没有工单，应该写「这一栏还是空的。」；现在画的是 %v", tt.Texts())
	}

	s.problem = "dial tcp: connection refused"
	tt = workPaneIn(s, PaletteFor(false))
	tt.Frame()
	if tt.HasText("这一栏还是空的。") {
		t.Error("断连时也写「这一栏还是空的」，等于说「没有工单」，可数据没读到")
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
			Tasks: []Task{{ID: "t1", Title: "改样式", State: "failed", BotID: "b1"}},
			Bots:  []BotCard{{ID: "b1", Name: "林", Persona: "前端"}},
		}
		return s
	}

	t.Run("工单卡", func(t *testing.T) {
		s := withTask()
		p := PaletteFor(false)
		tt := ui.NewTester(func(c *ui.Context) {
			ui.Row(c).Width(393).FillHeight().PaddingX(16).PaddingY(22).Background(p.Surface).Children(func() {
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
