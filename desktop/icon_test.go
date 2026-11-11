package main

import (
	"image"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 图标解析器只认 M / L / C / Z：认不出就报错，不静默画半截。
func TestParseIconAcceptsTheFourCommands(t *testing.T) {
	path, err := parseIcon("M4 7 L12 3 L20 7 Z")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(path.ops) != 4 || path.ops[0].kind != 'M' || path.ops[3].kind != 'Z' {
		t.Fatalf("ops: %+v", path.ops)
	}
}

func TestParseIconResolvesRelativeCommands(t *testing.T) {
	// 小写是相对坐标：`m4 4 l3 0` 的终点是 (7,4)，不是 (3,0)。
	path, err := parseIcon("M4 4 l3 0")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if path.ops[1].args[0] != 7 || path.ops[1].args[1] != 4 {
		t.Fatalf("relative L: %+v", path.ops[1])
	}
}

func TestEveryIconParses(t *testing.T) {
	// 图标表里有一条画不出来，那一栏就会少一枚图标 —— 这条测试把它钉在 CI 上。
	for name, d := range icons {
		if _, err := parseIcon(d); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestParseIconHandlesImplicitLineToAndDecimals(t *testing.T) {
	// `M` 之后直接跟第二组坐标，按 SVG 规矩是隐式 `L`。
	path, err := parseIcon("M1.5 2 3 4")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if path.ops[0].args[0] != 1.5 || path.ops[1].kind != 'L' {
		t.Fatalf("ops: %+v", path.ops)
	}
}

func TestParseIconRejectsWhatItCannotDraw(t *testing.T) {
	for _, bad := range []string{"M4 7 Q8 2 12 7", "L4", "M", "M1 1 R2 2"} {
		if _, err := parseIcon(bad); err == nil {
			t.Fatalf("should have failed: %q", bad)
		}
	}
}

func TestRenderIconPaintsWithinItsBox(t *testing.T) {
	img := renderIcon(icons["clock"], 16, ui.RGB(0, 0, 0))
	if img.Bounds().Dx() != 16 || img.Bounds().Dy() != 16 {
		t.Fatalf("bounds: %v", img.Bounds())
	}
	painted := 0
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a > 0 {
				painted++
			}
		}
	}
	if painted == 0 {
		t.Fatal("画出来是空的")
	}
	if painted == 16*16 {
		t.Fatal("整块都涂满了：路径没被当成描边")
	}
}

func TestRenderIconCarriesTheTint(t *testing.T) {
	img := renderIcon(icons["folder"], 16, ui.RGB(200, 100, 50))
	// 描边画法：中心是空的，得找一个真被涂到的像素来验颜色。
	var (
		r, g, b uint32
		found   bool
	)
	for y := 0; y < 16 && !found; y++ {
		for x := 0; x < 16; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a > 0 {
				r, g, b, _ = img.At(x, y).RGBA()
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatal("一个像素都没涂到")
	}
	// 涂到的地方必须是我们给的颜色，不是黑。
	if r>>8 != 200 || g>>8 != 100 || b>>8 != 50 {
		t.Fatalf("tint: %d %d %d", r>>8, g>>8, b>>8)
	}
}

func TestIconCacheReusesTheSameBitmap(t *testing.T) {
	first, ok1 := iconBitmap("clock", ui.RGB(1, 2, 3), 18)
	second, ok2 := iconBitmap("clock", ui.RGB(1, 2, 3), 18)
	if !ok1 || !ok2 {
		t.Fatal("iconBitmap 说不认识这个图标")
	}
	if first != second {
		t.Fatal("同一枚图标被重新光栅化了")
	}
}

func TestIconStaysSilentForAnUnknownName(t *testing.T) {
	// 认不出的名字不画、不崩：一栏少一枚图标比整屏报错好。
	var img *image.RGBA
	if got := iconImage("no-such-icon", ui.RGB(0, 0, 0), 16); got != nil {
		img = got
	}
	if img != nil {
		t.Fatal("不认识的图标不该画出东西")
	}
}
