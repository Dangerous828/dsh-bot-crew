// 分词着色。这一组钉住两件事：认得出画板里那几类，以及「认不出」时也绝不丢字符。
package main

import (
	"math"
	"strings"
	"testing"
)

// join 把分段拼回一行原文。任何高亮实现只要在这里对不上，就是吃掉了字符。
func join(segments []codeSegment) string {
	var builder strings.Builder
	for _, segment := range segments {
		builder.WriteString(segment.Text)
	}
	return builder.String()
}

// 画板 Desktop.dc.html:133 那一行：上下文整行暖灰，只有值 `12px` 是赭色。
func TestTheBoardLineColorsItsValue(t *testing.T) {
	p := PaletteFor(false)
	segments := codeSegments("  ", "gap: 12px;", p.Faint, p.Warn, true)

	if got, want := join(segments), "  gap: 12px;"; got != want {
		t.Fatalf("拼回去是 %q，原文是 %q —— 分词吃掉了字符", got, want)
	}
	// 值那一段必须是赭色，其余必须是暖灰。画板里正是这一处分色。
	// 暖灰有三段：行首两格、"gap: "、行尾的 ";"。
	var value, context int
	for _, segment := range segments {
		switch segment.Color {
		case p.Warn:
			value++
		case p.Faint:
			context++
		}
	}
	if value != 1 {
		t.Errorf("赭色段有 %d 个，画板里只有值那一处", value)
	}
	if context != 3 {
		t.Errorf("暖灰段有 %d 个，应该是行首两格、`gap: `、`;` 这三段", context)
	}
}

// 改动行不拆词：整行一个颜色。画板里新增行是整行淡绿底 + 绿字。
func TestAChangedLineStaysOneColor(t *testing.T) {
	p := PaletteFor(false)
	segments := codeSegments("+ ", "gap: 16px;", p.Accent, p.Warn, false)
	if got, want := join(segments), "+ gap: 16px;"; got != want {
		t.Fatalf("拼回去是 %q，原文是 %q", got, want)
	}
	for _, segment := range segments {
		if segment.Color != p.Accent {
			t.Errorf("改动行里出现了别的颜色 %v：整行该是一个颜色", segment.Color)
		}
	}
}

// 各种行都必须拼回原样。这是这一层唯一不能错的地方：
// 高亮是装饰，吃掉一个字符就是把代码改错了给人看。
func TestTokenizingNeverDropsCharacters(t *testing.T) {
	for _, line := range []string{
		"gap: 12px;",
		`color: "#FFF";`,
		"// 注释",
		"  # 井号开头",
		`const a = "a\"b";`,
		"x := 0x1f + 1.85",
		"没有数字也没有引号",
		"",
		"/* 块注释 */",
		"SELECT * FROM t -- SQL 注释",
		"不配对的引号 \" 后面还有字",
	} {
		segments := codeSegments("  ", line, LightPalette.Faint, LightPalette.Warn, true)
		if got := join(segments); got != "  "+line {
			t.Errorf("拼回去是 %q，原文是 %q", got, "  "+line)
		}
	}
}

// `#` 只在它前面整行都是空白时才算注释：`color: #FFF` 里的 # 是内容，
// 判成注释会让整整一行变成灰的，值就看不见了。
func TestAHashInsideAColorIsNotAComment(t *testing.T) {
	for _, token := range tokenizeCode("color: #FFF;") {
		if token.Kind == tokenComment {
			t.Errorf("颜色值被当成了注释：%q", token.Text)
		}
	}
	if token := tokenizeCode("# 真注释")[0]; token.Kind != tokenComment {
		t.Errorf("行首的 # 应该算注释，实际是 %v", token.Kind)
	}
	// 前面只有空白的 # 也算注释：那几格空白先成一段普通文字，注释是第二段。
	indented := tokenizeCode("   # 缩进后的注释")
	if len(indented) < 2 || indented[1].Kind != tokenComment {
		t.Errorf("前面只有空白的 # 应该算注释，实际是 %+v", indented)
	}
}

// 自减不是注释：`i--` 里的 `--` 贴着内容。
func TestADecrementIsNotAComment(t *testing.T) {
	for _, token := range tokenizeCode("i--;") {
		if token.Kind == tokenComment {
			t.Errorf("自减被当成了注释：%q", token.Text)
		}
	}
}

// 字符串里的数字不该被单独染色：`"12px"` 整段是字符串。
func TestANumberInsideAStringStaysAString(t *testing.T) {
	for _, token := range tokenizeCode(`margin: "12px";`) {
		if token.Kind == tokenNumber {
			t.Errorf("字符串里的数字被单独切出来了：%q", token.Text)
		}
	}
}

// 子代理行右侧那截话：跑完了的补耗时，在跑的、以及后端没给耗时的，都只说状态。
// 画板是「已完成 · 42 秒」；编不出这个数的时候，宁可只写「已完成」。
func TestASubagentOnlyShowsTheTimeItWasGiven(t *testing.T) {
	seconds := func(value float64) *float64 { return &value }

	// 后端给了耗时：状态在前、耗时在后，和画板一致。
	if got, want := agentStatus(AgentNode{State: "completed", ElapsedSeconds: seconds(42)}, false), "已完成 · 42 秒"; got != want {
		t.Errorf("给了耗时应该画出来：got %q want %q", got, want)
	}
	// 后端没给：只写状态，不许出现一个孤零零的「· 」。
	if got, want := agentStatus(AgentNode{State: "completed"}, false), "已完成"; got != want {
		t.Errorf("没给耗时时不该编：got %q want %q", got, want)
	}
	// 还在跑的不画耗时：它还没跑完，这个数此刻不成立。
	// 用词是画板上的「在跑」，不是工单卡上的「在做」。
	if got, want := agentStatus(AgentNode{State: "working", ElapsedSeconds: seconds(42)}, true), "在跑"; got != want {
		t.Errorf("在跑的不该画耗时：got %q want %q", got, want)
	}
}

// 耗时读坏了（负数、NaN）就不画那一截，不能画一个负数或「· 」。
func TestABrokenElapsedDrawsNothing(t *testing.T) {
	for _, value := range []float64{-1, -0.5} {
		broken := value
		if got := agentStatus(AgentNode{State: "completed", ElapsedSeconds: &broken}, false); got != "已完成" {
			t.Errorf("耗时 %v 读坏了，却画成了 %q", value, got)
		}
	}
	nan := math.NaN()
	if got := agentStatus(AgentNode{State: "completed", ElapsedSeconds: &nan}, false); got != "已完成" {
		t.Errorf("NaN 被画成了 %q", got)
	}
	// 无穷 / 超大浮点也要挡住：把超大浮点转成 int 在 Go 里是未定义结果，可能画出负数。
	huge := math.Inf(1)
	if got := agentStatus(AgentNode{State: "completed", ElapsedSeconds: &huge}, false); got != "已完成" {
		t.Errorf("无穷被画成了 %q", got)
	}
}

// 子代理那一行的状态词与工单卡不同：画板里是「在跑」/「已完成」，
// 工单卡上是「在做」。混用会有一边不像画板。
func TestAgentWordsDifferFromTicketWords(t *testing.T) {
	if got := agentWord("working"); got != "在跑" {
		t.Errorf("在跑的子代理说成了 %q", got)
	}
	if got := stateWord("working"); got != "在做" {
		t.Errorf("工单卡上应该还是「在做」，实际 %q", got)
	}
	if got := agentWord("completed"); got != "已完成" {
		t.Errorf("跑完的子代理说成了 %q", got)
	}
}

// 秒数的说法：一分钟以内说秒，超过就说「N 分 M 秒」——
// 一屏里出现「427 秒」没人算得过来。
func TestElapsedSaysMinutes(t *testing.T) {
	cases := map[float64]string{
		0:    "0 秒",
		42:   "42 秒",
		59.4: "59 秒",
		60:   "1 分 0 秒",
		65:   "1 分 5 秒",
		427:  "7 分 7 秒",
	}
	for seconds, want := range cases {
		if got := elapsedSeconds(seconds); got != want {
			t.Errorf("%v 秒说成了 %q，应该是 %q", seconds, got, want)
		}
	}
}