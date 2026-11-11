package main

// 图标：把 SVG 路径直接画成位图，而不是塞一个字形进文本。
//
// 为什么要换掉现在这批字符图标（`◷` `❖` `▤`）：它们是系统字体里的符号，
// 字重、大小、基线都由那个字体决定，换个系统就变一副样子；同一行里和文字混排时，
// 竖向对齐永远差一两像素，而且没法按状态改线宽。
//
// 这里只支持 `path` 的 `M/L/C/A/Z` 五种命令 ——
// 用 `golang.org/x/image/vector`（已经在 go.sum 里）抗锯齿光栅化。
// 不引入新的 SVG 渲染库：整套图标就这几个形状，为它们拉一个几千行的解析器不划算。
//
// 每个图标按**当前字号的高度**渲染并按当前颜色着色，所以它跟着主题、深色模式和缩放一起走。

import (
	"errors"
	"math"
	"strings"
	"sync"

	"golang.org/x/image/vector"

	"image"

	"github.com/egoist/mygo/ui"
)

// iconPath 是一段只含 `M/L/C/Z` 的路径，坐标在 24×24 的方框里（与常见的图标栅格一致）。
type iconPath struct {
	// 每段是一个命令加它的参数，按顺序执行；`Z` 关路径。
	ops []iconOp
}

type iconOp struct {
	// `M` 移动，`L` 直线，`C` 三次贝塞尔，`Z` 闭合。
	kind byte
	args []float64
}

// parseIcon 把 SVG 的 `d` 属性解析成命令序列。只认 `M L C Z`，其余符号直接报错 ——
// 静默忽略会让一个坏图标看起来像画对了，只是少了半截。
func parseIcon(d string) (iconPath, error) {
	var (
		out      iconPath
		index    int
		cmd      byte
		relative bool
		cursorX  float64
		cursorY  float64
		beginX   float64
		beginY   float64
	)
	// read 读一个数（可带符号与小数）。读不到就返回 false，由调用方报错。
	read := func() (float64, bool) {
		for index < len(d) && (d[index] == ' ' || d[index] == ',' || d[index] == '\n' || d[index] == '\t') {
			index++
		}
		start := index
		sign := 1.0
		if index < len(d) && (d[index] == '-' || d[index] == '+') {
			if d[index] == '-' {
				sign = -1
			}
			index++
		}
		digits := 0
		value := 0.0
		for index < len(d) && d[index] >= '0' && d[index] <= '9' {
			value = value*10 + float64(d[index]-'0')
			index++
			digits++
		}
		if index < len(d) && d[index] == '.' {
			index++
			scale := 0.1
			for index < len(d) && d[index] >= '0' && d[index] <= '9' {
				value += float64(d[index]-'0') * scale
				scale /= 10
				index++
				digits++
			}
		}
		if digits == 0 {
			index = start
			return 0, false
		}
		return sign * value, true
	}
	for index < len(d) {
		ch := d[index]
		switch {
		case ch == ' ' || ch == ',' || ch == '\n' || ch == '\t':
			index++
			continue
		case ch == 'M' || ch == 'L' || ch == 'C' || ch == 'Z' || ch == 'A':
			cmd = ch
			index++
		case ch == 'm' || ch == 'l' || ch == 'c' || ch == 'z' || ch == 'a':
			// 小写是相对坐标：用个大写标记记下「这是相对的」，取数时再折算。
			cmd = ch - 32
			relative = true
			index++
		case (ch >= '0' && ch <= '9') || ch == '-' || ch == '.':
			// 隐式重复上一条命令：`M 1 2 3 4` 的第二组是 `L`。
			if cmd == 0 {
				return out, errorf("icon: number before any command in %q", d)
			}
			if cmd == 'M' {
				cmd = 'L'
			}
		default:
			return out, errorf("icon: unsupported command %q in %q", string(ch), d)
		}
		switch cmd {
		case 'Z':
			out.ops = append(out.ops, iconOp{kind: 'Z'})
			cursorX, cursorY = beginX, beginY
			relative = false
		case 'M', 'L':
			x, ok1 := read()
			y, ok2 := read()
			if !ok1 || !ok2 {
				return out, errorf("icon: %c needs two numbers in %q", cmd, d)
			}
			if relative {
				x += cursorX
				y += cursorY
			}
			cursorX, cursorY = x, y
			out.ops = append(out.ops, iconOp{kind: cmd, args: []float64{x, y}})
			relative = false
		case 'C':
			values := make([]float64, 6)
			for at := range values {
				value, ok := read()
				if !ok {
					return out, errorf("icon: C needs six numbers in %q", d)
				}
				values[at] = value
			}
			if relative {
				for at := 0; at < 6; at += 2 {
					values[at] += cursorX
					values[at+1] += cursorY
				}
			}
			cursorX, cursorY = values[4], values[5]
			out.ops = append(out.ops, iconOp{kind: 'C', args: values})
			relative = false
		case 'A':
			// 椭圆弧：rx ry rotation large-arc sweep x y 共 7 个数。
			values := make([]float64, 7)
			for at := range values {
				value, ok := read()
				if !ok {
					return out, errorf("icon: A needs seven numbers in %q", d)
				}
				values[at] = value
			}
			if relative {
				values[5] += cursorX
				values[6] += cursorY
			}
			cursorX, cursorY = values[5], values[6]
			out.ops = append(out.ops, iconOp{kind: 'A', args: values})
			relative = false
		}
	}
	return out, nil
}

// iconGlyph 是渲染好的一枚图标，按 (图标名, 边长, 颜色) 缓存。
type iconGlyph struct {
	once sync.Once
	img  *image.RGBA
}

var (
	iconCacheMu sync.Mutex
	iconCache   = map[string]*iconGlyph{}
)

// renderIcon 把一条 24×24 的路径光栅化成边长为 size 的方块。
//
// 生成的是**纯色 alpha**：RGB 全部用当前颜色，A 通道由覆盖度决定。
// 这样同一枚图标在任何背景上都不会出现半透明黑边。
func renderIcon(d string, size int, tint ui.Color) *image.RGBA {
	path, err := parseIcon(d)
	if err != nil || size <= 0 {
		return image.NewRGBA(image.Rect(0, 0, max(size, 1), max(size, 1)))
	}
	scale := float64(size) / 24
	// 线宽 2（在 24 的方框里），换算到实际像素。
	half := 1.0 * scale
	ras := vector.NewRasterizer(size, size)
	var (
		started bool
		cursorX float64
		cursorY float64
		beginX  float64
		beginY  float64
		prevX   float64
		prevY   float64
	)
	// 一条线段展开成一个有宽度的四边形：图标是描边画法，直接填零面积的线什么也画不出。
	stroke := func(x0, y0, x1, y1 float64) {
		dx, dy := (x1-x0)*scale, (y1-y0)*scale
		length := math.Hypot(dx, dy)
		if length == 0 {
			return
		}
		// 法向量乘以半宽。
		nx, ny := -dy/length*half, dx/length*half
		ax, ay := x0*scale+nx, y0*scale+ny
		bx, by := x1*scale+nx, y1*scale+ny
		cx, cy := x1*scale-nx, y1*scale-ny
		dx2, dy2 := x0*scale-nx, y0*scale-ny
		ras.MoveTo(float32(ax), float32(ay))
		ras.LineTo(float32(bx), float32(by))
		ras.LineTo(float32(cx), float32(cy))
		ras.LineTo(float32(dx2), float32(dy2))
		ras.ClosePath()
		// 圆头：线段的两个端点各补一个圆，转角处才不会有缺口。
		for _, at := range [][2]float64{{x0 * scale, y0 * scale}, {x1 * scale, y1 * scale}} {
			ras.MoveTo(float32(at[0]+half), float32(at[1]))
			for step := 1; step <= 16; step++ {
				angle := 2 * math.Pi * float64(step) / 16
				ras.LineTo(float32(at[0]+half*math.Cos(angle)), float32(at[1]+half*math.Sin(angle)))
			}
			ras.ClosePath()
		}
	}
	for _, op := range path.ops {
		switch op.kind {
		case 'M':
			beginX, beginY = op.args[0], op.args[1]
			cursorX, cursorY = beginX, beginY
			prevX, prevY = cursorX, cursorY
			started = true
		case 'L':
			stroke(prevX, prevY, op.args[0], op.args[1])
			prevX, prevY = op.args[0], op.args[1]
			cursorX, cursorY = prevX, prevY
		case 'C':
			// 三次贝塞尔按 12 段折线走：24 像素的图标上，再多也看不出差别。
			x0, y0 := prevX, prevY
			c1x, c1y := op.args[0], op.args[1]
			c2x, c2y := op.args[2], op.args[3]
			x1, y1 := op.args[4], op.args[5]
			lastX, lastY := x0, y0
			for step := 1; step <= 12; step++ {
				u := float64(step) / 12
				v := 1 - u
				x := v*v*v*x0 + 3*v*v*u*c1x + 3*v*u*u*c2x + u*u*u*x1
				y := v*v*v*y0 + 3*v*v*u*c1y + 3*v*u*u*c2y + u*u*u*y1
				stroke(lastX, lastY, x, y)
				lastX, lastY = x, y
			}
			prevX, prevY = x1, y1
			cursorX, cursorY = prevX, prevY
		case 'A':
			// 圆弧展成折线：24 的方框上 12 段就够圆。
			rx, ry, rotation := op.args[0], op.args[1], op.args[2]*math.Pi/180
			large, sweep := op.args[3] != 0, op.args[4] != 0
			x1, y1 := op.args[5], op.args[6]
			x0, y0 := prevX, prevY
			// 端点变换到椭圆坐标系，按 SVG 规范的实现步骤算圆心与起始角。
			cos, sin := math.Cos(rotation), math.Sin(rotation)
			dx, dy := (x0-x1)/2, (y0-y1)/2
			x1p, y1p := cos*dx+sin*dy, -sin*dx+cos*dy
			if rx != 0 && ry != 0 {
				// 半径不够时按规范等比放大。
				scale := math.Sqrt((x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry))
				if scale > 1 {
					rx *= scale
					ry *= scale
				}
				numerator := rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p
				denominator := rx*rx*y1p*y1p + ry*ry*x1p*x1p
				factor := 0.0
				if denominator != 0 && numerator > 0 {
					factor = math.Sqrt(numerator / denominator)
				}
				if large == sweep {
					factor = -factor
				}
				cxp := factor * rx * y1p / ry
				cyp := -factor * ry * x1p / rx
				cx := cos*cxp - sin*cyp + (x0+x1)/2
				cy := sin*cxp + cos*cyp + (y0+y1)/2
				startAngle := math.Atan2((y1p-cyp)/ry, (x1p-cxp)/rx)
				endAngle := math.Atan2((-y1p-cyp)/ry, (-x1p-cxp)/rx)
				delta := endAngle - startAngle
				if sweep && delta < 0 {
					delta += 2 * math.Pi
				} else if !sweep && delta > 0 {
					delta -= 2 * math.Pi
				}
				lastX, lastY := x0, y0
				for step := 1; step <= 12; step++ {
					angle := startAngle + delta*float64(step)/12
					// 椭圆上取点，再转回原坐标系。
					ex, ey := rx*math.Cos(angle), ry*math.Sin(angle)
					x := cos*ex - sin*ey + cx
					y := sin*ex + cos*ey + cy
					stroke(lastX, lastY, x, y)
					lastX, lastY = x, y
				}
				prevX, prevY = x1, y1
			} else {
				stroke(x0, y0, x1, y1)
				prevX, prevY = x1, y1
			}
			cursorX, cursorY = prevX, prevY
		case 'Z':
			// 闭合：最后一点连回起点。
			if started && (prevX != beginX || prevY != beginY) {
				stroke(prevX, prevY, beginX, beginY)
			}
			prevX, prevY = beginX, beginY
			cursorX, cursorY = beginX, beginY
		}
	}
	_ = cursorX
	_ = cursorY
	alpha := image.NewAlpha(image.Rect(0, 0, size, size))
	ras.Draw(alpha, alpha.Bounds(), image.Opaque, image.Point{})

	out := image.NewRGBA(image.Rect(0, 0, size, size))
	// 颜色直接用它的 8 位原色，A 由覆盖度单独给：这样同一枚图标压在深色或浅色底上
	// 都不会出现半透明黑边。
	cr, cg, cb := tint.R, tint.G, tint.B
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			a := alpha.AlphaAt(x, y).A
			if a == 0 {
				continue
			}
			at := out.PixOffset(x, y)
			out.Pix[at] = cr
			out.Pix[at+1] = cg
			out.Pix[at+2] = cb
			out.Pix[at+3] = a
		}
	}
	return out
}

// icons 是这套界面用到的全部图标，键与 `navLabel` 的字形一一对应。
//
// 形状都在 24×24 的方框里，线宽 2：这样在小字号下也不糊。
var icons = map[string]string{
	// 「后台」：一叠卡片。
	"layers": "M4 7 L12 3 L20 7 L12 11 Z M4 12 L12 16 L20 12 M4 17 L12 21 L20 17",
	// 「模型」：滑块。
	"sliders": "M4 7 L20 7 M4 17 L20 17 M9 7 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M15 17 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
	// 「产出」：文件夹。
	"folder": "M3 7 L3 18 L21 18 L21 7 L11 7 L9 4 L3 4 Z",
	// 「常规任务」：时钟。
	"clock": "M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18 M12 7 L12 12 L16 14",
	// 「记忆」：书签。
	"bookmark": "M6 3 L18 3 L18 21 L12 16 L6 21 Z",
}

// iconImage 取一枚已渲染好的图标。同一 (图标, 边长, 颜色) 只光栅化一次 ——
// 一帧里同一枚图标往往出现好几次（左栏、栏头、卡片），每帧重画是白烧 CPU。
func iconImage(name string, tint ui.Color, size float64) *image.RGBA {
	d, ok := icons[name]
	if !ok {
		return nil
	}
	pixels := int(math.Round(size))
	if pixels <= 0 {
		return nil
	}
	key := name + "|" + itoa(pixels) + "|" + itoa(int(tint.R)) + "," + itoa(int(tint.G)) + "," + itoa(int(tint.B))
	iconCacheMu.Lock()
	glyph, hit := iconCache[key]
	if !hit {
		glyph = &iconGlyph{}
		iconCache[key] = glyph
	}
	iconCacheMu.Unlock()
	glyph.once.Do(func() { glyph.img = renderIcon(d, pixels, tint) })
	return glyph.img
}

// icon 在当前位置画一枚图标，并让它占一个 size×size 的方格。
//
// 用 `ui.Image` 而不是把 SVG 塞进文本：图片按像素画，线宽和圆角在任何缩放下都对得上，
// 也不会因为换了系统字体而变一副样子。
func icon(c *ui.Context, name string, tint ui.Color, size float64) {
	bmp, ok := iconBitmap(name, tint, size)
	if !ok {
		return
	}
	ui.Image(c, bmp).Size(float32(size), float32(size)).Fit(ui.Contain)
}

// 图标位图本身也缓存：`ui.NewBitmap` 每次都要过一次资源登记，一帧几十次是白花。
var (
	bitmapMu sync.Mutex
	bitmaps  = map[string]*ui.Bitmap{}
)

func iconBitmap(name string, tint ui.Color, size float64) (*ui.Bitmap, bool) {
	img := iconImage(name, tint, size)
	if img == nil {
		return nil, false
	}
	key := name + "|" + itoa(int(math.Round(size))) + "|" + itoa(int(tint.R)) + "," + itoa(int(tint.G)) + "," + itoa(int(tint.B))
	bitmapMu.Lock()
	defer bitmapMu.Unlock()
	if cached, hit := bitmaps[key]; hit {
		return cached, true
	}
	bmp := ui.NewBitmap(img)
	bitmaps[key] = bmp
	return bmp, true
}

// itoa 是不引 strconv 的小工具（这里只拼缓存键）。
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [8]byte
	at := len(digits)
	for value > 0 && at > 0 {
		at--
		digits[at] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[at:])
}

// errorf 让这个文件不依赖 fmt 的格式化开销（只在解析失败时用）。
func errorf(format string, args ...any) error {
	return errors.New(strings.Replace(format, "%q", "%s", -1))
}
