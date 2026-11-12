// 配色：从设计稿抽出来的两套命名颜色。界面只按名字取色，不写字面色值。
package main

import (
	"os"
	"strings"

	"github.com/egoist/mygo/ui"
)

// Palette 是一套主题里用到的全部颜色。亮暗两套同名不同值。
// 字段是 ui.Color 而不是十六进制串：取色只在这里发生，界面拿到的永远是可画的颜色。
type Palette struct {
	// Surface 是页面底，Card 是浮在它上面的卡片与栏。
	Surface ui.Color
	Card    ui.Color
	// Ink 是主文字，Muted 是次要文字，Faint 是更弱的一层（占位、时间戳）。
	Ink    ui.Color
	Muted  ui.Color
	Faint  ui.Color
	Line   ui.Color
	Accent ui.Color
	// AccentInk 是压在 Accent 上的文字色。亮色主题里它是白的，暗色主题里要压深，否则读不清。
	AccentInk ui.Color
	// Warn 是「等你决定」那一类，Danger 是失败。
	Warn   ui.Color
	Danger ui.Color
	// WarnInk 是压在 Warn 实底上的字。亮色主题里它是白的（画板角标 #96603A 底 + #FFFFFF 字），
	// 暗色主题里要压深（#E0A574 底 + #232228 字）—— 两套的赭不在一个明度档上，
	// 共用一个 AccentInk 会让暗色下白字压在亮赭上，几乎读不出来。
	// 用在未读徽标（契约 §5.6）与消息头像那种赭色实底上。
	WarnInk ui.Color
	// UserBubble 和 UserInk 是自己发出去的那一侧。
	UserBubble ui.Color
	UserInk    ui.Color
	// Selected 是花名册里选中那一项的底色。设计稿用它代替边框，靠色块分层。
	Selected ui.Color
	// AccentSoft 是强调色的淡底：头像块、徽标、标签都用它。
	AccentSoft ui.Color
	// WarnSoft 是警告语义的淡底，和 AccentSoft 成对。
	WarnSoft ui.Color
	// Code 是消息里代码片段的底，比卡片再深/浅一档。
	Code ui.Color
	// 下面这几个是从画板的计算样式里取出来的，源码里没有但确实画在屏幕上。
	Hint       ui.Color
	DangerSoft ui.Color
	Raised     ui.Color
	InkStrong  ui.Color
	// 下面这几个只在暗色里有差别：同样一块地方，亮色用同一层，暗色要分两档才看得出来。
	SelectedAlt ui.Color
	AccentSoft2 ui.Color
	WarnSoft2   ui.Color
	WarnEdge    ui.Color
	DangerEdge  ui.Color
	Footer      ui.Color
	// Track 是分段控件那条轨的底色：右栏那三个页签（进行中 / 待你 / 已完成）坐在里面，
	// 选中的那个抬起一层。画板亮色 `#EFEBE5`、暗色 `#2A2830`，见 桌面亮色-坐标.md 的「标签栏（整条）」。
	Track ui.Color
	// Pressed 是选中项被按住时的底色：比抬起那一层再压深一点，按下就有回音。
	Pressed ui.Color
	// PressedSoft 是没选中的页签被按住时的底：轨道里浮起一层很淡的色，别压过选中项。
	PressedSoft ui.Color
	// EmptyEdge / EmptyGlyph / EmptyGlyphSoft 是空态那两个虚线框：
	// 边框比普通 Line 更暖（画板 #D9D3C9），里面的人形/气泡是两种暖灰
	// （#B8B1A5 / #C9C2B6）。用 Line + Faint 画出来会显得发灰、没有温度。
	EmptyEdge      ui.Color
	EmptyGlyph     ui.Color
	EmptyGlyphSoft ui.Color
	// RowRule 是卡片内部行与行之间的分隔：比 Line 再淡一档（画板 #F4F0EA）。
	RowRule ui.Color
	// Faintest 是脚注那种「比卡片再浅一层」的底（画板 #FDFCFA）。
	Faintest ui.Color
	// DangerDeep 是断连横幅里那段正文：比 Danger 更深，因为它是一段要读的话，
	// 不是一个告警符号。画板亮色 #8A4038 / 暗色 #E58A80（暗色下已经够亮）。
	DangerDeep ui.Color
	// WarmBase 是「等你决定」卡的底：比 WarmSoft 再暖一档、几乎就是页底色。
	// 画板用 #FDF9F4（亮色）/ 暖深（暗色），和普通的 WeakSoft 区分开 ——
	// 它是「需要你动手」的那一块，不该和警告徽标同色。
	WarmBase ui.Color
}

// LightPalette 是暖白底的一套。
var LightPalette = Palette{
	Surface: ui.Hex("#FBF9F6"), Card: ui.Hex("#FFFFFF"),
	Ink: ui.Hex("#1F1D1A"), Muted: ui.Hex("#57524A"), Faint: ui.Hex("#8A8377"), Line: ui.Hex("#EDE8E1"),
	Accent: ui.Hex("#3E6B62"), AccentInk: ui.Hex("#FFFFFF"),
	Warn: ui.Hex("#96603A"), Danger: ui.Hex("#B45252"), WarnInk: ui.Hex("#FFFFFF"),
	UserBubble: ui.Hex("#2C2A26"), UserInk: ui.Hex("#FBF9F6"),
	Selected: ui.Hex("#F3F0EA"), AccentSoft: ui.Hex("#EAF1EC"), WarnSoft: ui.Hex("#F6EEE6"),
	Code: ui.Hex("#F5F2EC"),
	// 花名册的第二档淡底、警告/失败的边线与脚注底。画板里它们在亮色下与主档几乎同色，
	// 暗色下才明显分层；这里两套都给实值，零值等于透明，画出来会少一整块。
	SelectedAlt: ui.Hex("#F3F0EA"), AccentSoft2: ui.Hex("#EAF1EC"), WarnSoft2: ui.Hex("#F6EEE6"),
	WarnEdge: ui.Hex("#E9D9C9"), DangerEdge: ui.Hex("#E5C4C4"), Footer: ui.Hex("#F8F5F1"),
	// 以下四个是从画板的实际计算样式里取的，源码里 grep 不到但它们真的画出来了。
	Hint:       ui.Hex("#6F6A60"), // 占位与辅助说明在亮色底上仍有足够对比度
	DangerSoft: ui.Hex("#FDF6F6"), // 失败卡的底
	Raised:     ui.Hex("#F8F5F1"), // 比 Card 浅一点的那层
	InkStrong:  ui.Hex("#171717"), // 标题那种更实的黑
	// 分段控件的三段：轨道照画板；按住时的两层画板上没有，取同一族里深一档，
	// 让「按下去」看得出来，又不抢过选中那个白胶囊。
	Track:       ui.Hex("#EFEBE5"), // 页签条整条（画板 Desktop.dc.html:252）
	Pressed:     ui.Hex("#E3DED6"), // 选中项被按住
	PressedSoft: ui.Hex("#E7E3DC"), // 未选中项被按住
	WarmBase:    ui.Hex("#FDF9F4"), // 「等你决定」卡底（画板 Desktop.dc.html:200）
	DangerDeep:  ui.Hex("#8A4038"), // 断连横幅正文（画板 Desktop-offline.dc.html:100）
	RowRule:     ui.Hex("#F4F0EA"), // 卡内行分隔（画板 Desktop.dc.html:173）
	EmptyEdge:      ui.Hex("#D9D3C9"), // 空态虚线框（画板 Desktop-empty.dc.html:31/51）
	EmptyGlyph:     ui.Hex("#B8B1A5"), // 空态人形/气泡图标
	EmptyGlyphSoft: ui.Hex("#C9C2B6"), // 空态次级图标
	Faintest:    ui.Hex("#FDFCFA"), // 脚注底（画板 Desktop.dc.html:188）
}

// DarkPalette 是深墨底的一套。强调色提亮一档，否则它和底色糊在一起。
var DarkPalette = Palette{
	Surface: ui.Hex("#17161A"), Card: ui.Hex("#232228"),
	Ink: ui.Hex("#F2EFEA"), Muted: ui.Hex("#C4BFB6"), Faint: ui.Hex("#928C82"), Line: ui.Hex("#33313A"),
	Accent: ui.Hex("#5FBFA8"), AccentInk: ui.Hex("#10201C"),
	Warn: ui.Hex("#E0A574"), Danger: ui.Hex("#E58A80"), WarnInk: ui.Hex("#232228"),
	UserBubble: ui.Hex("#3B3942"), UserInk: ui.Hex("#F2EFEA"),
	Selected: ui.Hex("#2A2830"), AccentSoft: ui.Hex("#1E3A34"), WarnSoft: ui.Hex("#3A2A1C"),
	Code:        ui.Hex("#1E1D23"),
	SelectedAlt: ui.Hex("#2A2830"), AccentSoft2: ui.Hex("#1E3A34"), WarnSoft2: ui.Hex("#3A2A1C"),
	WarnEdge: ui.Hex("#4A3A28"), DangerEdge: ui.Hex("#55302F"), Footer: ui.Hex("#25242A"),
	Hint: ui.Hex("#6E6860"), DangerSoft: ui.Hex("#2A1E1E"), Raised: ui.Hex("#1D1C21"),
	InkStrong: ui.Hex("#FFFFFF"),
	// 暗色：轨道与选中项照画板（Desktop-dark.dc.html:252 的 #2A2830 / #232228），
	// 按住的两层按同族取，选中项比卡片再深一点才分得出来。
	Track:       ui.Hex("#2A2830"),
	Pressed:     ui.Hex("#1B1A20"),
	PressedSoft: ui.Hex("#35333B"),
	// 画板暗色里「等你决定」卡是暖深 #241F1A；比 WarnSoft 更深，压在卡片上不发光。
	WarmBase:   ui.Hex("#241F1A"),
	DangerDeep: ui.Hex("#E58A80"),
	// 暗色下「比卡片浅一层」在视觉上不存在：脚注用抬起层，行分隔用分隔色。
	RowRule:  ui.Hex("#2A2830"),
	Faintest: ui.Hex("#1D1C21"),
	// 暗色没有对应的暖灰：虚线框落到分隔色，图标落到弱字色。
	EmptyEdge:      ui.Hex("#33313A"),
	EmptyGlyph:     ui.Hex("#928C82"),
	EmptyGlyphSoft: ui.Hex("#6E6860"),
}

// PaletteFor 按是否深色返回对应的一套。
func PaletteFor(dark bool) Palette {
	if dark {
		return DarkPalette
	}
	return LightPalette
}

// ThemeColors 从 mygo 的主题里取这套配色：它记着系统外观，所以窗口跟着系统变。
//
// CREW_THEME=light|dark 只是拍照/对照时的开关：验亮色得把系统切成亮色，
// 而这台机器是别人的工作环境。设了就用它，没设照样跟系统走。
func ThemeColors(t *ui.Theme) Palette {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CREW_THEME"))) {
	case "light":
		return LightPalette
	case "dark":
		return DarkPalette
	}
	return PaletteFor(t != nil && t.Dark)
}

// 设计稿里的字号与圆角是一套固定的刻度，逐像素还原时直接引用，
// 不要在调用点写裸数字 —— 那样改一处就得全文件找一遍。
const (
	// 字号
	FontHairline   = 10.5 // 职能、时间戳
	FontTiny       = 11.0 // 标签、徽标
	FontSmall      = 11.5 // 次要说明
	FontBody       = 12.0 // 状态行
	FontBodyWide   = 12.5 // 输入框、正文旁注
	FontLabel      = 13.0 // 导航项
	FontName       = 13.5 // 花名册的名字
	FontText       = 14.0 // 消息正文
	FontHeader     = 14.5 // 栏标题
	FontTitle      = 15.0 // 页面标题
	FontDisplay    = 15.5 // 主标题（设计稿里有，界面还没到）
	FontGlyph      = 17.0 // 加号、图标字（同上）
	FontIcon       = 16.0 // 导航图标（画板里图标字是 16px）
	FontRosterIcon = 24.0 // 左栏标题的虚线圆图标（画板 24px）
	FontEmptyIcon  = 26.0 // 空态图标（画板 64×64 框内 26px）
	FontDot        = 6.0  // 状态点（5px 的点用 6px 的字画）
	FontMini       = 9.0  // 极小的说明字（配对区的附注）
	FontCode       = 22.0 // 配对码那种要一眼看清的数字
	// 圆角
	RadiusTiny   = 2  // 进度条、细条
	RadiusDot    = 5  // 小圆点
	RadiusChip   = 6  // 内联徽标
	RadiusItem   = 8  // 导航项
	RadiusButton = 9  // 标题栏那个 109×31 的按钮（画板实测）
	RadiusCard   = 10 // 右栏工单卡（画板实测 10，不是 9）
	RadiusPane   = 11 // 花名册条目、头像块
	// 空态有两个虚线框，尺寸与圆角都不同，别混用：
	// 左栏「队伍还是空的」是 52×52 / 16；中栏「还没有人说话」是 64×64 / 20。
	RadiusFolder    = 20 // 中栏空态那个虚线头像框（画板 64×64）
	RadiusFolderSml = 16 // 左栏空态那个虚线加号框（画板 52×52）
	RadiusBig    = 13 // 输入区
	RadiusBubble = 15 // 消息气泡
	RadiusTail   = 4  // 气泡靠说话人那一侧的尖角

	// 字重。画板用的是 640 / 620 / 600 / 550 这些非整数档，
	// 全用 Bold()（700）会比画板整体偏重，一眼能看出差别。
	WeightTitle  = 640 // 栏标题「我的队伍」
	WeightName   = 600 // 花名册里的名字
	WeightCard   = 550 // 工单标题
	WeightLabel  = 600 // 标签页选中的那个（画板里未选中 400，实现统一用这一档）
	WeightFigure = 620 // 头像里那个字
)

// 尺寸
const (
	SidebarWidth = 329 // 左栏（画板实测值）
	BackendWidth = 393 // 右栏（画板实测值）
	AvatarSmall  = 36  // 花名册头像
	AvatarHdr    = 38  // 标题栏头像（画板实测）
	ContentMax   = 718 // 中栏（画板实测）
	ContentInset = 75  // 中栏**正文**左边距（404 − 329）：36 + 头像 28 + 间距 11
	// MessageInset 是消息行（含头像）的左右内缩。画板里消息行从 36 起，
	// 正文落在 75 是因为头像和间距把它推过去的 —— 别把 75 当成行的起点。
	MessageInset = 36

	// 右栏那条分段控件。数字全来自 designs/personal-agent/桌面亮色-坐标.md「右栏」：
	// 标签栏（整条）下内边距 3（52 − 49）、高 32（95 − 49 − 12 的余量即 32）、
	// 每个页签 115×26（1067 与 1186 之间隔 4：1186 − (1067 + 115)）。
	TabHeight   = 32  // 整条轨道
	TabWidth    = 115 // 一个页签
	TabGap      = 4   // 页签之间
	TabBarInset = 3   // 轨道与页签的上下留白（32 − 26 = 6，两边各 3）
)
