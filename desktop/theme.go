// 配色：从设计稿抽出来的两套命名颜色。界面只按名字取色，不写字面色值。
package main

import "github.com/egoist/mygo/ui"

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
}

// LightPalette 是暖白底的一套。
var LightPalette = Palette{
	Surface: ui.Hex("#FBF9F6"), Card: ui.Hex("#FFFFFF"),
	Ink: ui.Hex("#1F1D1A"), Muted: ui.Hex("#57524A"), Faint: ui.Hex("#8A8377"), Line: ui.Hex("#EDE8E1"),
	Accent: ui.Hex("#3E6B62"), AccentInk: ui.Hex("#FFFFFF"),
	Warn: ui.Hex("#96603A"), Danger: ui.Hex("#B45252"),
	UserBubble: ui.Hex("#2C2A26"), UserInk: ui.Hex("#FBF9F6"),
	Selected: ui.Hex("#F3F0EA"), AccentSoft: ui.Hex("#EAF1EC"), WarnSoft: ui.Hex("#F6EEE6"),
	Code: ui.Hex("#F5F2EC"),
	// 以下四个是从画板的实际计算样式里取的，源码里 grep 不到但它们真的画出来了。
	Hint:       ui.Hex("#A9A294"), // 比 Faint 再淡一档：占位、极弱说明
	DangerSoft: ui.Hex("#FDF6F6"), // 失败卡的底
	Raised:     ui.Hex("#F8F5F1"), // 比 Card 浅一点的那层
	InkStrong:  ui.Hex("#171717"), // 标题那种更实的黑
}

// DarkPalette 是深墨底的一套。强调色提亮一档，否则它和底色糊在一起。
var DarkPalette = Palette{
	Surface: ui.Hex("#17161A"), Card: ui.Hex("#232228"),
	Ink: ui.Hex("#F2EFEA"), Muted: ui.Hex("#C4BFB6"), Faint: ui.Hex("#928C82"), Line: ui.Hex("#33313A"),
	Accent: ui.Hex("#5FBFA8"), AccentInk: ui.Hex("#10201C"),
	Warn: ui.Hex("#E0A574"), Danger: ui.Hex("#E58A80"),
	UserBubble: ui.Hex("#3B3942"), UserInk: ui.Hex("#F2EFEA"),
	Selected: ui.Hex("#2E2C34"), AccentSoft: ui.Hex("#1D2F2A"), WarnSoft: ui.Hex("#33291F"),
	Code: ui.Hex("#1E1D23"),
	Hint: ui.Hex("#6E6960"), DangerSoft: ui.Hex("#2A2022"), Raised: ui.Hex("#1B1A1F"),
	InkStrong: ui.Hex("#FFFFFF"),
}

// PaletteFor 按是否深色返回对应的一套。
func PaletteFor(dark bool) Palette {
	if dark {
		return DarkPalette
	}
	return LightPalette
}

// ThemeColors 从 mygo 的主题里取这套配色：它记着系统外观，所以窗口跟着系统变。
func ThemeColors(t *ui.Theme) Palette {
	return PaletteFor(t != nil && t.Dark)
}

// 设计稿里的字号与圆角是一套固定的刻度，逐像素还原时直接引用，
// 不要在调用点写裸数字 —— 那样改一处就得全文件找一遍。
const (
	// 字号
	FontHairline = 10.5 // 职能、时间戳
	FontTiny     = 11.0 // 标签、徽标
	FontSmall    = 11.5 // 次要说明
	FontBody     = 12.0 // 状态行
	FontBodyWide = 12.5 // 输入框、正文旁注
	FontLabel    = 13.0 // 导航项
	FontName     = 13.5 // 花名册的名字
	FontText     = 14.0 // 消息正文
	FontHeader   = 14.5 // 栏标题
	FontTitle    = 15.0 // 页面标题
	FontDisplay  = 15.5 // 主标题（设计稿里有，界面还没到）
	FontGlyph    = 17.0 // 加号、图标字（同上）
	FontIcon     = 16.0 // 导航图标（画板里图标字是 16px）
	FontDot      = 6.0  // 状态点（5px 的点用 6px 的字画）
	FontMini     = 9.0  // 极小的说明字（配对区的附注）
	FontCode     = 22.0 // 配对码那种要一眼看清的数字
	// 圆角
	RadiusTiny   = 2  // 进度条、细条
	RadiusDot    = 5  // 小圆点
	RadiusChip   = 6  // 内联徽标
	RadiusItem   = 8  // 导航项
	RadiusButton = 9  // 标题栏那个 109×31 的按钮（画板实测）
	RadiusCard   = 10 // 右栏工单卡（画板实测 10，不是 9）
	RadiusPane   = 11 // 花名册条目、头像块
	RadiusBig    = 13 // 输入区
	RadiusBubble = 15 // 消息气泡
	RadiusTail   = 4  // 气泡靠说话人那一侧的尖角

	// 字重。画板用的是 640 / 620 / 600 / 550 这些非整数档，
	// 全用 Bold()（700）会比画板整体偏重，一眼能看出差别。
	WeightTitle  = 640 // 栏标题「我的队伍」
	WeightName   = 600 // 花名册里的名字
	WeightCard   = 550 // 工单标题
	WeightLabel  = 600 // 标签页选中的那个
	WeightFigure = 620 // 头像里那个字
)

// 尺寸
const (
	SidebarWidth = 329 // 左栏（画板实测值）
	BackendWidth = 393 // 右栏（画板实测值）
	AvatarSmall  = 36  // 花名册头像
	AvatarHdr    = 38  // 标题栏头像（画板实测）
	ContentMax   = 718 // 中栏（画板实测）
	ContentInset = 75  // 中栏内容左边距（404 − 329）
)
