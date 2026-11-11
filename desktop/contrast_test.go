package main

import (
	"math"
	"reflect"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 对比度。这一组测试盯的是「字在它的底上读不读得清」——
// 本次会话里暗色主题下文字隐形过一次，光看代码看不出来，只能算。

// luminance 按 WCAG 的算法算相对亮度。
func luminance(c ui.Color) float64 {
	channel := func(v float64) float64 {
		if v <= 0.03928 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(float64(c.R)/255) +
		0.7152*channel(float64(c.G)/255) +
		0.0722*channel(float64(c.B)/255)
}

// contrast 是 WCAG 对比度，1 到 21。
func contrast(a, b ui.Color) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func TestTextIsReadableOnItsBackground(t *testing.T) {
	cases := []struct {
		name string
		p    Palette
		ink  ui.Color
		on   ui.Color
	}{
		// 正文压在页面上
		{"亮/正文", LightPalette, LightPalette.Ink, LightPalette.Surface},
		{"暗/正文", DarkPalette, DarkPalette.Ink, DarkPalette.Surface},
		// 正文压在卡片上
		{"亮/卡片正文", LightPalette, LightPalette.Ink, LightPalette.Card},
		{"暗/卡片正文", DarkPalette, DarkPalette.Ink, DarkPalette.Card},
		// 次要文字
		{"亮/次要", LightPalette, LightPalette.Muted, LightPalette.Card},
		{"暗/次要", DarkPalette, DarkPalette.Muted, DarkPalette.Card},
		// 自己发的话：反白压在深底上
		{"亮/气泡", LightPalette, LightPalette.UserInk, LightPalette.UserBubble},
		{"暗/气泡", DarkPalette, DarkPalette.UserInk, DarkPalette.UserBubble},
		// 强调色当文字
		{"亮/强调", LightPalette, LightPalette.Accent, LightPalette.Card},
		{"暗/强调", DarkPalette, DarkPalette.Accent, DarkPalette.Card},
	}
	for _, c := range cases {
		// 4.5 是 WCAG AA 对正文的要求；这些字号都在 14 左右，属于正文。
		if got := contrast(c.ink, c.on); got < 4.5 {
			t.Errorf("%s: 对比度 %.2f，低于 4.5（字会看不清）", c.name, got)
		}
	}
}

// 弱化文字（时间戳、职能）可以低一些，但也不能低到看不见。
func TestFaintTextStillVisible(t *testing.T) {
	for _, c := range []struct {
		name string
		p    Palette
	}{{"亮", LightPalette}, {"暗", DarkPalette}} {
		if got := contrast(c.p.Faint, c.p.Card); got < 2.5 {
			t.Errorf("%s/弱化文字: 对比度 %.2f，低于 2.5", c.name, got)
		}
	}
}

// 强调色压在它自己的淡底上（头像块、标签）也要能读。
func TestAccentOnItsSoftBackground(t *testing.T) {
	for _, c := range []struct {
		name string
		p    Palette
	}{{"亮", LightPalette}, {"暗", DarkPalette}} {
		if got := contrast(c.p.Accent, c.p.AccentSoft2); got < 3 {
			t.Errorf("%s/强调压在淡底上: 对比度 %.2f，低于 3", c.name, got)
		}
		if got := contrast(c.p.Warn, c.p.WarnSoft2); got < 3 {
			t.Errorf("%s/警告压在淡底上: 对比度 %.2f，低于 3", c.name, got)
		}
	}
}

// 压在赭色实底上的字（未读徽标、赭色头像、「回」按钮）。
//
// 这一条单独测，是因为两套主题的赭不在一个明度档上：亮色是深赭，配白字；
// 暗色是亮赭，必须配深字。共用一个 AccentInk 时暗色下白字压在 #E0A574 上只有
// 1.9:1 —— 正是「暗色下文字隐形」那一类缺陷，靠看代码看不出来，只能算。
func TestWarnInkIsReadableOnWarn(t *testing.T) {
	for _, c := range []struct {
		name string
		p    Palette
	}{{"亮", LightPalette}, {"暗", DarkPalette}} {
		// 徽标字只有 11px，属于小字，按 4.5 要求。
		if got := contrast(c.p.WarnInk, c.p.Warn); got < 4.5 {
			t.Errorf("%s/赭底上的字: 对比度 %.2f，低于 4.5（徽标会看不清）", c.name, got)
		}
	}
}

// 调色板的每个字段都必须是不透明的。
//
// 漏赋值时 ui.Color 是零值：alpha=0，画出来什么都没有。花名册选中底、头像块、
// 警告边线就这么一起消失过一次，而对比度测试按 RGB 计算，看不出来。
func TestEveryPaletteColorIsOpaque(t *testing.T) {
	for _, entry := range []struct {
		name string
		p    Palette
	}{{"亮", LightPalette}, {"暗", DarkPalette}} {
		value := reflect.ValueOf(entry.p)
		kind := value.Type()
		for i := 0; i < value.NumField(); i++ {
			color := value.Field(i).Interface().(ui.Color)
			if color.A != 255 {
				t.Errorf("%s/%s 的 alpha 是 %d，画出来是透明的；补上实值", entry.name, kind.Field(i).Name, color.A)
			}
		}
	}
}
