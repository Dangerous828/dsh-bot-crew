// modes.go —— 桌面端的两个镜头：聊天 / 分拣台。
//
// 同一本账，换镜头：mode 只决定中栏怎么画，不新建状态、不发请求、不重新拉账。
// 契约 §1：Ticket 是唯一状态主体，事务板里的每一条就是 tasks[] 里的一项；
// 聊天模式是常规暗色群聊 + 右侧事务板，分拣台是纸感案头的三段流水线。
package main

import "github.com/egoist/mygo/ui"

// appMode 是中栏的两种画法。零值就是 modeChat：默认落在日常聊天。
type appMode int

const (
	modeChat appMode = iota
	modeTriage
)

// modeName 给调试快照用。认不出就说 unknown，不拿一个默认值冒充。
func modeName(mode appMode) string {
	switch mode {
	case modeChat:
		return "chat"
	case modeTriage:
		return "triage"
	}
	return "unknown"
}

// modeSwitch 是标题栏那条普通 segmented：两个小按钮，
// 没有纸质翻牌、没有衬线、没有印章 —— 那些是分拣台的语言，日常聊天用不上。
//
// 点一下只切 s.mode。mygo 点完自己会重画，所以这里不 wake、不 loadXxx。
func (s *app) modeSwitch(c *ui.Context, p Palette) {
	ui.Row(c).Height(28).Padding(3).Gap(2).Radius(RadiusChip).Background(p.Track).
		AlignItems(ui.Center).Children(func() {
		for _, option := range []struct {
			label string
			mode  appMode
		}{{"聊天", modeChat}, {"分拣台", modeTriage}} {
			choice := option
			soft, tint := ui.Transparent, p.Faint
			if s.mode == choice.mode {
				soft, tint = p.Card, p.Ink
			}
			ui.Row(c).Height(22).PaddingX(10).Radius(RadiusChip).Background(soft).
				Center().ClipX().Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, choice.label).FontSize(FontSmall).TextColor(tint)
			}).OnClick(func() { s.mode = choice.mode })
		}
	})
}
