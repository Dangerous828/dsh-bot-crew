// 代码卡里那一行代码的分词着色。
//
// 为什么先做「分词」而不是接一个完整的高亮库：画板要的只有一件事 ——
// 一行代码里「变了的部分」要看得见。画板 Desktop.dc.html:133 里，
// 上下文行是暖灰 `#8A8377`，而值 `12px` 是赭色 `#96603A`；改动行整行是绿的。
// 达到这个效果只需要认出「数字 / 字符串 / 注释」三类，不需要语法树。
//
// 这一层刻意不认识具体语言，也不做错误恢复：认不出来的就原样当普通文字，
// 拼回去必须和原文逐字相同（见 syntax_test.go）—— 高亮可以少，不能吃掉字符。
package main

import "github.com/egoist/mygo/ui"

// codeTokenKind 是一段文字属于哪一类。零值是普通文字。
type codeTokenKind int

const (
	tokenPlain codeTokenKind = iota
	// tokenNumber 是数字字面量（含 12px 里的 12、0x1f、1.85）。
	tokenNumber
	// tokenString 是引号里的内容，引号本身也算这一段：否则贴着引号的空格会被吃掉。
	tokenString
	// tokenComment 是行尾注释，一直吃到行尾。
	tokenComment
)

// codeToken 是分词结果里的一段。Text 原样取自输入，不做 trim。
type codeToken struct {
	Text string
	Kind codeTokenKind
}

// tokenizeCode 把一行代码切成若干段。
//
// 规则少到能一眼读完，这才是它敢用的原因：
//   - `//`、`/*`、`#`（行首或前面是空白）、`--` 起的注释，吃到行尾；
//   - `"…"` 与 `'…'` 的字符串，到配对的引号为止（配不上就到行尾）；
//   - 连续的数字（允许夹一个小数点）算一个数字；
//   - 其余整段算普通文字。
func tokenizeCode(text string) []codeToken {
	runes := []rune(text)
	var tokens []codeToken
	plain := make([]rune, 0, len(runes))
	flush := func() {
		if len(plain) > 0 {
			tokens = append(tokens, codeToken{Text: string(plain), Kind: tokenPlain})
			plain = plain[:0]
		}
	}
	for i := 0; i < len(runes); {
		r := runes[i]
		switch {
		case isCommentStart(runes, i):
			flush()
			tokens = append(tokens, codeToken{Text: string(runes[i:]), Kind: tokenComment})
			i = len(runes)
		case r == '"' || r == '\'':
			flush()
			end := i + 1
			for end < len(runes) && runes[end] != r {
				// 反斜杠转义：`"a\"b"` 的引号不算结束。
				if runes[end] == '\\' && end+1 < len(runes) {
					end++
				}
				end++
			}
			if end < len(runes) {
				end++ // 收尾那个引号一起算进来
			}
			tokens = append(tokens, codeToken{Text: string(runes[i:end]), Kind: tokenString})
			i = end
		case r >= '0' && r <= '9':
			flush()
			end := i
			for end < len(runes) && isNumberRune(runes[end]) {
				end++
			}
			tokens = append(tokens, codeToken{Text: string(runes[i:end]), Kind: tokenNumber})
			i = end
		default:
			plain = append(plain, r)
			i++
		}
	}
	flush()
	return tokens
}

// isCommentStart 判断 i 处是不是一段注释的开头。
//
// `//` 与 `--` 要求前面不是内容字符：`i--` 是自减，不是注释。
// `#` 更严 —— 只有它前面整行都是空白才算（shell / yaml / python 的行首注释）。
// 放宽到「前面是空格就算」，`color: #FFF` 的颜色值会被整行染灰，值就看不见了；
// 宁可漏认一行 `x = 1 # 尾注`，也不能把颜色值认成注释。
func isCommentStart(runes []rune, i int) bool {
	before := runes[:i]
	rest := runes[i:]
	switch {
	case len(rest) >= 2 && rest[0] == '/' && (rest[1] == '/' || rest[1] == '*'):
		return !hasContentBefore(before)
	case len(rest) >= 2 && rest[0] == '-' && rest[1] == '-':
		return !hasContentBefore(before)
	case rest[0] == '#':
		for _, r := range before {
			if r != ' ' && r != '\t' {
				return false
			}
		}
		return true
	}
	return false
}

// hasContentBefore 判断这之前有没有代码 —— 只有最后一个字符不是空白，才算「贴着内容」。
func hasContentBefore(before []rune) bool {
	if len(before) == 0 {
		return false
	}
	last := before[len(before)-1]
	return last != ' ' && last != '\t'
}

// isNumberRune 是数字的一部分：数字、字母（认 0x1f 与 12px 的 px）、小数点。
// `px` 跟着数字走，是为了让 `12px` 整段染成一个颜色 —— 画板里那一段正是赭色。
func isNumberRune(r rune) bool {
	return r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '.'
}

// codeSegment 是画到屏幕上的一段：文字加它自己的颜色。
type codeSegment struct {
	Text  string
	Color ui.Color
}

// codeSegments 把一行代码变成可以直接铺进 Row 的几段。
//
// 三种行三套配色，都照画板：
//   - 上下文行：整行暖灰（Faint），值那一截用赭色（Warn）—— 这是画板里
//     `gap: <span style="color:#96603A">12px</span>;` 那一段；
//   - 新增行 / 删除行：整行一个颜色（Accent / Warn），因为画板里改动的
//     是**整行**，行内再分色反而看不出哪一行变了。
//
// prefix 是行首那两格（"  " / "+ " / "- "）：它属于这一行，不属于某个词，
// 所以单独成一段、跟着整行颜色走。
func codeSegments(prefix, text string, base, value ui.Color, highlight bool) []codeSegment {
	segments := []codeSegment{{Text: prefix, Color: base}}
	if !highlight {
		return append(segments, codeSegment{Text: text, Color: base})
	}
	for _, token := range tokenizeCode(text) {
		color := base
		switch token.Kind {
		case tokenNumber:
			color = value
		case tokenString:
			color = value
		}
		segments = append(segments, codeSegment{Text: token.Text, Color: color})
	}
	return segments
}