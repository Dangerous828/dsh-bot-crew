package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// 三栏宽度的边界是纯函数，直接在表上验，不用模拟指针。
func TestFitPaneKeepsWidthInsideItsBounds(t *testing.T) {
	cases := []struct {
		name            string
		v, lo, hi, room float32
		want            float32
	}{
		{name: "低于下限往上收", v: 180, lo: 220, hi: 420, room: 1000, want: 220},
		{name: "高于上限往下收", v: 560, lo: 220, hi: 420, room: 1000, want: 420},
		{name: "范围内原样", v: 320, lo: 220, hi: 420, room: 1000, want: 320},
		{name: "窗口紧时按剩余空间收", v: 420, lo: 220, hi: 420, room: 300, want: 300},
		{name: "窗口窄到放不下下限时先让路", v: 329, lo: 220, hi: 420, room: 100, want: 100},
		{name: "再窄也留 Split 的 40", v: 329, lo: 220, hi: 420, room: 10, want: 40},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fitPane(tc.v, tc.lo, tc.hi, tc.room); got != tc.want {
				t.Errorf("fitPane(%v, %v, %v, room=%v) = %v，想要 %v",
					tc.v, tc.lo, tc.hi, tc.room, got, tc.want)
			}
		})
	}
}

// 窗口缩小时两栏宽度要被收回有效范围，中栏不会被挤成负数。
func TestPaneWidthsFollowTheWindow(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1440, 900)
	tt.Frame()
	if s.sidebarWidth != SidebarWidth || s.backendWidth != BackendWidth {
		t.Fatalf("打开窗口的宽度是左 %v / 右 %v，应该是设计稿的 %v / %v",
			s.sidebarWidth, s.backendWidth, SidebarWidth, BackendWidth)
	}

	tt.SetSize(800, 900)
	tt.Frame()
	if s.sidebarWidth < sidebarMinWidth || s.sidebarWidth > sidebarMaxWidth {
		t.Errorf("窗口 800 宽时左栏是 %v，超出 %v–%v", s.sidebarWidth, sidebarMinWidth, sidebarMaxWidth)
	}
	if s.backendWidth < backendMinWidth || s.backendWidth > backendMaxWidth {
		t.Errorf("窗口 800 宽时右栏是 %v，超出 %v–%v", s.backendWidth, backendMinWidth, backendMaxWidth)
	}
	if total := s.sidebarWidth + s.backendWidth; total+middleMinWidth > 800 {
		t.Errorf("窗口 800 宽，两栏合计 %v，中栏已经保不住 %v", total, middleMinWidth)
	}
}

// ui.Split 自带指针拖拽：真按住分隔条拖，宽度状态要跟着变。
func TestDraggingTheDividersResizesThePanes(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1440, 900)
	tt.Frame()

	// 左栏：分隔条在 x = 左栏宽度（线 1px，手柄左右各覆 3px）。
	x := s.sidebarWidth + 0.5
	tt.Press(x, 120)
	tt.Move(x+40, 120)
	tt.Release(x+40, 120)
	tt.Frame()
	if want := float32(SidebarWidth + 40); s.sidebarWidth != want {
		t.Fatalf("向左栏分隔条右拖 40，左栏是 %v，应该是 %v", s.sidebarWidth, want)
	}

	// 拖过头要被上限挡住，不能一路把中栏吃掉。
	x = s.sidebarWidth + 0.5
	tt.Press(x, 120)
	tt.Move(x+600, 120)
	tt.Release(x+600, 120)
	tt.Frame()
	if s.sidebarWidth != sidebarMaxWidth {
		t.Fatalf("左栏拖过上限后是 %v，应该收在 %v", s.sidebarWidth, sidebarMaxWidth)
	}

	// 右栏：分隔条在中/右之间；方向反过来，往左拖是把它拖宽。
	x = 1440 - s.backendWidth - 1
	tt.Press(x, 120)
	tt.Move(x-40, 120)
	tt.Release(x-40, 120)
	tt.Frame()
	if want := float32(BackendWidth + 40); s.backendWidth != want {
		t.Fatalf("向右栏分隔条左拖 40，右栏是 %v，应该是 %v", s.backendWidth, want)
	}
}

// 拖窄任何一栏、或把窗口缩小，内容都不能跑出窗口。
//
// 之前页签是定宽 115：右栏拖到 308 时三个页签共 345，把「0 张」「收起 ›」「配对手机」
// 一起顶到栏外，看起来就是「拖了不生效、左右两侧不跟着自适应」。这条按真实窗口量，
// 任何一段文字跑出窗口就算失败。
func TestNothingSpillsOutWhenPanesAreDraggedNarrow(t *testing.T) {
	cases := []struct{ w, h int; side, back float32 }{
		{995, 560, 220, 300}, {995, 560, 420, 520}, {1280, 714, 226, 308},
		{1280, 714, 329, 393}, {1440, 900, 329, 393}, {1440, 900, 420, 520},
	}
	for _, tc := range cases {
		s := newApp(New("http://127.0.0.1:1", "t", ""))
		s.conversation = &Conversation{
			Bots: []BotCard{{ID: "lead", Name: "大哥", Persona: "简练，先应一声再决定。"},
				{ID: "scribbler", Name: "写手", Persona: "中文文案。克制，不堆词。"},
				{ID: "coder", Name: "码农", Persona: "写代码先看现有约定。"}},
			DefaultBotID: "lead", Status: BackendStatus{Runtime: "ready", Mobile: "ready"},
			Tasks: []Task{{ID: "t1", Title: "改一个很长的标题看看会不会挤出去", State: "work", Open: true, BotID: "coder"}},
		}
		s.backendOpen = true
		s.sidebarWidth, s.backendWidth = tc.side, tc.back
		tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, tc.w, tc.h)
		tt.Frame()
		tt.Frame()
		for _, word := range tt.Texts() {
			r, ok := tt.Find(word)
			if !ok || r.W == 0 {
				continue
			}
			if r.X+r.W > float32(tc.w)+1 {
				t.Errorf("窗口 %dx%d、左右栏 %.0f/%.0f 时，%q 跑到 x=%.0f..%.0f，已经在窗口外",
					tc.w, tc.h, tc.side, tc.back, word, r.X, r.X+r.W)
			}
		}
	}
}

// 窗口从大缩到小，宽度要跟着收，中栏不能被挤掉。
func TestShrinkingTheWindowKeepsEveryPaneUsable(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	s.conversation = &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}, DefaultBotID: "lead",
		Status: BackendStatus{Runtime: "ready", Mobile: "ready"}}
	s.backendOpen = true
	tt := ui.NewTester(func(c *ui.Context) { s.view(c) }, 1440, 900)
	tt.Frame()
	for _, size := range [][2]int{{1200, 800}, {1000, 700}, {900, 620}, {700, 560}, {1600, 1000}} {
		tt.SetSize(size[0], size[1])
		tt.Frame()
		tt.Frame()
		total := s.sidebarWidth + s.backendWidth + middleMinWidth
		if total > float32(size[0]) {
			t.Errorf("窗口 %d 宽时，两栏 %.0f+%.0f 加上中栏下限 %.0f = %.0f，已经放不下",
				size[0], s.sidebarWidth, s.backendWidth, middleMinWidth, total)
		}
		for _, word := range tt.Texts() {
			r, ok := tt.Find(word)
			if !ok || r.W == 0 {
				continue
			}
			if r.X+r.W > float32(size[0])+1 {
				t.Errorf("窗口 %d 宽时 %q 跑到窗口外（x=%.0f..%.0f）", size[0], word, r.X, r.X+r.W)
				break
			}
		}
	}
}
